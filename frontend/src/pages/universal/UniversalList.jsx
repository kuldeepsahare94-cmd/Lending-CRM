import { geoSeed } from '../../components/geo/GeoField';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Kanban as KanbanIcon, Search, MoreHorizontal, Eye, Pencil, LayoutGrid } from 'lucide-react';
import { UniversalRecordEditModal } from '../../components/RecordEditModal';
import ScheduleMeetingModal from '../../components/ScheduleMeetingModal';
import { ModuleIcon } from '../../components/moduleIcons';
import { accentFor, accentGradient } from '../../theme/moduleAccents';
import { avatarGradientFor, initialsOf } from '../../theme/avatarColors';
import QuotationItemsEditor from './QuotationItemsEditor';
import { PhotoChooser, ProductThumb } from '../../components/ProductPhoto';
import { api } from '../../api';
import { usePermissions } from '../../context/usePermissions';
import StatusBadge from '../../components/StatusBadge';
import { downloadCSV } from '../../utils/csv';
import { getFieldValue, formatFieldValue, renderFieldValue, FieldInput, recordTitle, fieldLabel } from './fieldUtils';
import { cachedLabel } from './lookupCache';
import { computeFollowupStatus, findFollowupField } from './followupUtils';
import { pickCardField, extrasFor } from './listKpis';
import StatusCards, { statusBreakdown, breakdownFromServer, matchesStatus, normaliseOptions, BLANK } from '../../components/StatusCards';
import { SkeletonRows, ErrorState, friendlyError } from '../../components/ui';
import DrillBanner, { useDrill, applyDrill } from '../../components/DrillBanner';
import AssignPicker from '../../components/AssignPicker';
import { loadDirectory } from '../../components/userDirectory';
import { remember, recall } from '../../screenMemory';
import {
  FilterButton, FilterPanel, ActiveFilterChips, SavedFiltersMenu, applyFilters, isComplete, useMe, extraRecordFields,
  useSelection, RowCheckbox, BulkBar, BulkUpdateModal, BulkAssignModal, BulkDeleteModal, runBulk,
} from '../../components/ListTools';
import { USER_TYPES } from './fieldUtils';

const STATUS_TYPES = new Set(['status', 'contact_status', 'priority']);

// These lists come from the server as the newest 200 rows only (they grow by
// hundreds a day). Their status cards therefore take the real totals from
// the server instead of counting the rows on screen — see "bigList" below.
const NEWEST_ROWS_ONLY = new Set(['calls', 'meetings', 'tasks', 'notes', 'emails']);


export default function UniversalList() {
  const { moduleApiName } = useParams();
  const navigate = useNavigate();
  const can = usePermissions();

  // Coming back to this list shows what it showed last time at once; fresh
  // rows replace it a moment later (see screenMemory.js).
  const memKey = `list:${moduleApiName}`;
  const [shown] = useState(() => recall(memKey));
  const [module, setModule] = useState(shown?.module || null);
  const [fields, setFields] = useState(shown?.fields || []);
  const [records, setRecords] = useState(shown?.records || []);
  const [recordsLoaded, setRecordsLoaded] = useState(!!shown);
  const [loading, setLoading] = useState(!shown);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  // Quotation line items live outside `form` because they're a child
  // collection, not a column on the record.
  const [quoteItems, setQuoteItems] = useState([]);
  // A product photo picked in the create form; uploaded once the product exists.
  const [newPhoto, setNewPhoto] = useState(null);
  useEffect(() => { if (!showForm) setNewPhoto(null); }, [showForm]);
  const [discountType, setDiscountType] = useState('percent');
  const [discountValue, setDiscountValue] = useState(0);
  // Quotations, proforma invoices and invoices are all built the same way:
  // a header form plus line items, saved together. The create form offers the
  // line-item editor for all three rather than for quotations alone.
  const SALES_DOCUMENTS = ['quotations', 'proforma_invoices', 'invoices'];
  const isQuotations = SALES_DOCUMENTS.includes(moduleApiName);
  const isProducts = moduleApiName === 'products';
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [openMenu, setOpenMenu] = useState(null);
  const [editingId, setEditingId] = useState(null);   // row being edited in the popup
  const [kpiFilter, setKpiFilter] = useState(null);
  // The status card that is chosen, when the cards are built from a field
  // other than the one the Status dropdown filters (Accounts: account type).
  const [cardFilter, setCardFilter] = useState('');
  // Whole-table totals per status ({ total, limit, counts }) for the lists
  // above; null for every other module.
  const [serverCounts, setServerCounts] = useState(shown?.counts || null);
  const loadSeq = useRef(0);
  const [fieldErrors, setFieldErrors] = useState({});
  const PAGE_SIZE = 25;
  // Opened from a dashboard figure: narrow to exactly the records behind it.
  const drill = useDrill();
  // Field filters, saved filters, row selection and bulk actions.
  const me = useMe();
  const [showFilters, setShowFilters] = useState(false);
  const [conditions, setConditions] = useState([]);
  const [match, setMatch] = useState('all');
  const [activeSaved, setActiveSaved] = useState(null);
  const [savedRefresh, setSavedRefresh] = useState(0);
  const [bulk, setBulk] = useState(null);   // 'update' | 'assign' | 'delete'
  const selection = useSelection(moduleApiName);
  useEffect(() => { setConditions([]); setActiveSaved(null); setShowFilters(false); }, [moduleApiName]);

  useEffect(() => {
    if (!recall(memKey)) setLoading(true);
    setError('');
    // Performance: the saved-filter menu and the owner/team names are needed
    // as soon as the list renders. Ask for them now, alongside the module
    // info, instead of after the page has rendered (one fewer round trip).
    api.prefetchSavedFilters(moduleApiName);
    loadDirectory();
    api.getModuleMeta(moduleApiName)
      .then(async (mod) => {
        setModule(mod);
        const f = await api.listModuleFields(mod.id);
        setFields(f);
      })
      .catch((e) => setError(friendlyError(e, `Unable to load ${moduleApiName}.`)))
      .finally(() => setLoading(false));
  }, [moduleApiName]);


  const listFields = useMemo(() => fields.filter((f) => f.show_in_list), [fields]);
  const createFields = useMemo(() => fields.filter((f) => f.show_in_create), [fields]);

  const defaultsForCreate = useMemo(() => {
    const out = geoSeed(createFields);
    createFields.forEach((f) => {
      if (f.default_value === null || f.default_value === undefined || f.default_value === '') return;
      out[f.api_name] = f.field_type === 'checkbox'
        ? ['1', 'true', 'yes'].includes(String(f.default_value).toLowerCase())
        : f.default_value;
    });
    return out;
  }, [createFields]);
  // ?new=1 (from the Support Command Center's "New Ticket" and similar
  // shortcuts) opens the create form on arrival.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') !== '1' || !module || !fields.length) return;
    if (can(module.api_name, 'create')) { setForm(defaultsForCreate); setShowForm(true); }
    const next = new URLSearchParams(searchParams); next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, module, fields.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusField = useMemo(() => fields.find((f) => STATUS_TYPES.has(f.api_name)), [fields]);
  const followupField = useMemo(() => findFollowupField(fields), [fields]);

  // Options for the status filter: prefer the field's own configured
  // options, fall back to whatever values the data actually contains.
  const statusOptions = useMemo(() => {
    if (!statusField) return [];
    try {
      const opts = JSON.parse(statusField.options_json || '[]');
      if (opts.length) return opts.map((o) => (typeof o === 'string' ? o : o.value ?? o.label));
    } catch { /* fall through to deriving from data */ }
    return [...new Set(records.map((r) => r[statusField.api_name]).filter(Boolean))];
  }, [statusField, records]);

  // The field the status cards are built from (see listKpis.js). When it is
  // the same field as the Status dropdown, the two are one control.
  const cardField = useMemo(() => pickCardField(moduleApiName, fields, records), [moduleApiName, fields, records]);
  const cardIsDropdown = !!cardField && !!statusField && cardField.api_name === statusField.api_name;
  const cardValue = cardIsDropdown ? statusFilter : cardFilter;
  const setCardValue = cardIsDropdown ? setStatusFilter : setCardFilter;

  // A list that is longer than the server sends (more than 200 calls, say):
  // the cards show the server's real totals, and choosing a status card asks
  // the server for that status's rows, so nothing older is left out.
  const bigList = !!serverCounts && !drill.active && serverCounts.total > (serverCounts.limit || 200);
  // Server totals are per Status, so they are used only when the cards are
  // built from the Status field.
  const serverCards = bigList && cardField?.api_name === 'status';
  const serverStatus = serverCards && cardValue && cardValue !== BLANK ? cardValue : '';

  const load = () => {
    if (!module) return;
    // While a drill-down is resolving, wait for its ids rather than loading
    // (and briefly showing) the unfiltered list. The ids are passed to the
    // API too, so a list endpoint with a row cap still returns every match.
    if (drill.active && !drill.idSet) return;
    // Custom fields on a standard module live in a separate store; their
    // values are merged onto each row so the list can filter on them too.
    const hasCustom = !!module.table_name && fields.some((f) => !f.is_system);
    const wantCounts = NEWEST_ROWS_ONLY.has(module.api_name) && !drill.active;
    const seq = ++loadSeq.current;
    Promise.all([
      api.universalList(module, { q, ids: drill.active ? drill.idsParam : undefined, status: serverStatus || undefined }),
      hasCustom ? api.getAllCustomFieldValues(module.api_name).catch(() => ({})) : null,
      // An older server without this route answers "not found": the cards
      // then count the rows on screen, as for every other module.
      wantCounts ? api.statusCounts(module, { q }).catch(() => null) : null,
    ])
      .then(([rows, custom, counts]) => {
        if (seq !== loadSeq.current) return;   // an older answer arriving late
        const merged = custom && Array.isArray(rows) ? rows.map((r) => ({ ...r, ...(custom[r.id] || {}) })) : rows;
        const totals = counts && typeof counts.total === 'number' ? counts : null;
        setRecords(merged);
        setServerCounts(totals);
        setRecordsLoaded(true);
        if (!q && !drill.active && !serverStatus && Array.isArray(merged)) remember(memKey, { module, fields, records: merged, counts: totals });
      })
      .catch((e) => { if (seq === loadSeq.current) setError(friendlyError(e, 'Unable to load records.')); });
  };
  const customKey = fields.filter((f) => !f.is_system).length;
  useEffect(() => { load(); }, [module, drill.idsParam, drill.active, customKey, serverStatus]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [q]);
  // Every configured field, plus columns the records carry that are not
  // configured fields (a pipeline's Stage, for one).
  const filterFields = useMemo(() => [...fields, ...extraRecordFields(records, fields, module)], [fields, records, module]);
  // Opportunities: Stage is set through the pipeline, so mass update offers it
  // as its own field, listing the pipeline's stages.
  const [stages, setStages] = useState([]);
  // The pipeline's stage names in pipeline order, for the Deals status cards.
  const [stageOrder, setStageOrder] = useState([]);
  useEffect(() => {
    if (module?.api_name !== 'opportunities') { setStages([]); setStageOrder([]); return; }
    api.listPipelines('opportunities').then((ps) => {
      const live = ps.filter((x) => x.active !== 0);
      const many = live.length > 1;
      const liveStages = live.flatMap((pl) => (pl.stages || []).filter((st) => st.active !== 0).map((st) => ({ pl, st })));
      setStages(liveStages.map(({ pl, st }) => ({ value: st.id, label: many ? `${pl.name} · ${st.name}` : st.name })));
      const names = new Set();
      setStageOrder(liveStages.filter(({ st }) => !names.has(st.name) && names.add(st.name))
        .map(({ st }) => ({ value: st.name, label: st.name, color: st.color || undefined })));
    }).catch(() => { setStages([]); setStageOrder([]); });
  }, [module?.api_name]);
  const massFields = useMemo(() => (stages.length
    ? [{ api_name: 'stage_id', label: 'Stage', field_type: 'dropdown', value_type: 'number', pipeline_stage: true, is_system: 1, show_in_edit: 1, options_json: JSON.stringify(stages) }, ...fields]
    : fields), [stages, fields]);

  // Every control narrows the list, and each card is counted with all the
  // OTHER controls applied — so the number on a card is always the number of
  // rows you get when you click it.
  //   common    search, dashboard drill-down, Status dropdown, filter panel
  //   forCards  common + the chosen "other figure" card (Overdue, …)
  //   filtered  forCards + the chosen status card = the rows in the table
  const common = useMemo(() => {
    let rows = applyDrill(records, drill);
    if (statusField && statusFilter && !cardIsDropdown) {
      rows = rows.filter((r) => matchesStatus(getFieldValue(r, statusField), statusFilter));
    }
    return applyFilters(rows, conditions, match, filterFields, getFieldValue, me);
  }, [records, statusField, statusFilter, cardIsDropdown, drill.idSet, drill.active, conditions, match, filterFields, me]);

  const inCard = useMemo(
    () => (cardField && cardValue ? (r) => matchesStatus(getFieldValue(r, cardField), cardValue) : null),
    [cardField, cardValue],
  );
  // The money / date figures describe the rows of the chosen status. They are
  // sums over the rows on screen, so they are left out when the screen holds
  // only the newest part of a long list — a partial sum would be a wrong one.
  const extras = useMemo(
    () => (records.length && !bigList ? extrasFor(moduleApiName, inCard ? common.filter(inCard) : common) : []),
    [moduleApiName, records.length, bigList, common, inCard],
  );
  const activeExtra = extras.find((k) => k.label === kpiFilter && k.filter) || null;
  const forCards = useMemo(
    () => (activeExtra ? common.filter(activeExtra.filter) : common),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [common, activeExtra?.label],
  );
  const cardOptions = useMemo(
    () => (cardField?.api_name === 'stage_name' ? stageOrder : normaliseOptions(cardField?.options_json)),
    [cardField, stageOrder],
  );
  const statusCards = useMemo(() => {
    if (!cardField) return [];
    const blankLabel = `No ${(cardField.label || 'status').toLowerCase()}`;
    // A long list: the server's totals for the whole module.
    if (serverCards) return breakdownFromServer(serverCounts.counts, cardOptions, { selected: cardValue, blankLabel });
    return statusBreakdown(forCards, (r) => getFieldValue(r, cardField), cardOptions, {
      selected: cardValue,
      blankLabel,
      colorOf: cardField.api_name === 'stage_name' ? (r) => r.stage_color : undefined,
    });
  }, [cardField, forCards, cardOptions, cardValue, serverCards, serverCounts]);
  const totalCount = serverCards ? serverCounts.total : forCards.length;
  // How many records the current choice really has, when that is more than
  // the server sent (shown under the table so nobody thinks the rest is gone).
  const fullCount = !bigList ? null
    : (serverStatus ? (statusCards.find((c) => c.value === serverStatus)?.count ?? null) : serverCounts.total);
  const filtered = useMemo(() => (inCard ? forCards.filter(inCard) : forCards), [forCards, inCard]);
  const TotalIcon = useMemo(() => {
    const name = module?.icon;
    return function TotalIcon(props) { return <ModuleIcon name={name} {...props} />; };
  }, [module?.icon]);


  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [q, statusFilter, cardFilter, kpiFilter, moduleApiName, drill.metric, conditions, match]);
  // Filters that could no longer match are dropped from the selection, so a
  // bulk action never touches a record the user can't see.
  useEffect(() => {
    const visible = new Set(filtered.map((r) => r.id));
    const stale = [...selection.ids].filter((id) => !visible.has(id));
    if (stale.length) selection.setMany(stale, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  // Guard order matters. `if (!module) return null` used to run BEFORE the
  // loading check, so while the module was being fetched the page rendered
  // literally nothing — an empty content area indistinguishable from a
  // broken page.
  //
  // It was also only a truthiness check. If the API returned an unexpected
  // shape (an empty array, an object without labels) it passed this guard
  // and then threw on `module.plural_label.toLowerCase()`, taking out the
  // whole route.
  if (loading) {
    return <div className="w-full"><SkeletonRows rows={8} cols={5} /></div>;
  }
  if (error) {
    return (
      <div className="w-full">
        <ErrorState message={error.message || String(error)} detail={error.detail}
          onRetry={() => { setLoading(true); setError(''); }} />
      </div>
    );
  }
  if (!module || typeof module !== 'object' || !module.api_name) {
    return (
      <div className="w-full">
        <ErrorState message={`The "${moduleApiName}" module could not be loaded.`}
          detail={`Expected module metadata, received: ${JSON.stringify(module)}`}
          onRetry={() => { setLoading(true); setError(''); }} />
      </div>
    );
  }

  // Labels are rendered in several places; missing metadata must degrade to
  // the module's api_name rather than throwing.
  const accent = accentFor(module.api_name);
  const pluralLabel = (module.plural_label || module.api_name || 'records');
  const singularLabel = (module.singular_label || module.api_name || 'record');

  // Custom fields on a standard module are stored apart from the record, so
  // the list rows don't carry them and they can't be filtered client-side.
  const userFields = fields.filter((f) => USER_TYPES.has(f.field_type) && f.show_in_edit !== 0);
  const canEdit = can(module.api_name, 'edit');
  const pageIds = pageRows.map((r) => r.id);
  const pageSelected = pageIds.length > 0 && pageIds.every((id) => selection.has(id));
  const somePageSelected = pageIds.some((id) => selection.has(id));
  const selectedIds = [...selection.ids];

  // One record's update, through the same route a normal edit uses.
  const updateOne = (field, value) => (id) => (module.table_name && !field.is_system
    ? api.saveCustomFieldValues(module.api_name, id, { [field.api_name]: value })
    : api.universalUpdate(module, id, { [field.api_name]: value }));
  const runUpdate = async (field, value, onProgress) => {
    const result = await runBulk(selectedIds, updateOne(field, value), onProgress);
    load();
    return result;
  };
  // Mass update: all chosen fields in one save per record. A pipeline stage
  // moves through the stage route (history, probability, automations); custom
  // fields on a standard module go to their own store.
  const runUpdateMany = async (changes, onProgress) => {
    const stage = changes.find((c) => c.field.pipeline_stage);
    const custom = changes.filter((c) => !c.field.pipeline_stage && module.table_name && !c.field.is_system);
    const standard = changes.filter((c) => !c.field.pipeline_stage && !custom.includes(c));
    const result = await runBulk(selectedIds, async (id) => {
      if (stage && stage.value != null) await api.moveOpportunityStage(id, stage.value);
      if (standard.length) await api.universalUpdate(module, id, Object.fromEntries(standard.map((c) => [c.field.api_name, c.value])));
      if (custom.length) await api.saveCustomFieldValues(module.api_name, id, Object.fromEntries(custom.map((c) => [c.field.api_name, c.value])));
    }, onProgress);
    load();
    return result;
  };
  const runDelete = async (onProgress) => {
    const result = await runBulk(selectedIds, (id) => api.universalDelete(module, id), onProgress, 2);
    selection.clear();
    load();
    return result;
  };
  const exportSelected = () => downloadCSV(`${module.api_name}-selected.csv`, filtered.filter((r) => selection.has(r.id)).map((r) => {
    const row = { id: r.id };
    listFields.forEach((f) => {
      const v = getFieldValue(r, f);
      row[f.label] = f.field_type === 'lookup' ? (cachedLabel(f.lookup_module, v) ?? '') : formatFieldValue(v, f);
    });
    return row;
  }));
  // Re-assign one record straight from its row.
  const reassign = (r, field) => async (value) => {
    await updateOne(field, value)(r.id);
    setRecords((rs) => rs.map((x) => (x.id === r.id ? { ...x, [field.api_name]: value } : x)));
  };

  // Types where an empty value is legitimate, matching the server's list —
  // a checkbox that is off, or a file uploaded separately, is not "missing".
  const REQUIRED_EXEMPT = new Set(['checkbox', 'file', 'image']);

  const validateRequired = () => {
    const errs = {};
    createFields.forEach((f) => {
      if (!f.required || REQUIRED_EXEMPT.has(f.field_type)) return;
      const v = form[f.api_name];
      if (v === undefined || v === null || String(v).trim() === '') {
        errs[f.api_name] = `${f.label} is required`;
      }
    });
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validateRequired()) return;
    setSaving(true);
    try {
      const payload = isQuotations
        ? {
          ...form,
          items: quoteItems.map((i) => ({
            product_id: i.product_id || null,
            description: i.description || null,
            quantity: Number(i.quantity) || 0,
            unit_price: Number(i.unit_price) || 0,
            discount_percent: Number(i.discount_percent) || 0,
            tax_percent: Number(i.tax_percent) || 0,
          })),
          overall_discount_type: discountType,
          overall_discount_value: Number(discountValue) || 0,
        }
        : form;
      const created = await api.universalCreate(module, payload);
      if (isProducts && newPhoto && created?.id) {
        const { image, thumb, fit, original_name, original_bytes } = newPhoto;
        try {
          await api.saveProductImage(created.id, { image, thumb, fit, original_name, original_bytes });
        } catch (photoErr) {
          alert(`The product was saved, but its photo was not: ${photoErr.message}\nOpen the product to add the photo again.`);
        }
      }
      setNewPhoto(null);
      setForm(defaultsForCreate);
      setQuoteItems([]);
      setDiscountValue(0);
      setShowForm(false);
      load();
    } catch (err) {
      // Closing the "already in the CRM" pop-up is a choice, not a failure.
      if (!err.cancelled) alert('Could not save: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // Lookup columns hold a row id. Exporting those raw produced a spreadsheet
  // with a "Customer" column full of numbers — the names are already on
  // screen, so use the same resolved values the table is showing.
  const exportCsv = () => downloadCSV(`${module.api_name}.csv`, records.map((r) => {
    const row = { id: r.id };
    listFields.forEach((f) => {
      const v = getFieldValue(r, f);
      row[f.label] = f.field_type === 'lookup'
        ? (cachedLabel(f.lookup_module, v) ?? '')
        : v;
    });
    return row;
  }));



  return (
    <div className="relative rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6">
      {/* Background treatment, tinted by THIS module's accent — so Accounts
          sits on a faint blue wash and Tickets on a rose one, while the
          treatment itself (dot grid + corner blooms) is identical
          everywhere. That's the uniform-system / distinct-module split
          applied to the canvas rather than just the components.

          Every layer is pointer-events-none behind a negative z-index, so
          it can never intercept a click or sit on top of content. */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${accent.solid}33 1px, transparent 0)`,
          backgroundSize: '22px 22px',
        }} />
        <div className="absolute -top-32 -right-28 w-[520px] h-[520px] rounded-full" style={{
          background: `radial-gradient(circle, ${accent.solid}38, transparent 70%)`,
        }} />
        <div className="absolute -bottom-36 -left-28 w-[460px] h-[460px] rounded-full" style={{
          background: `radial-gradient(circle, ${accent.solid}2E, transparent 70%)`,
        }} />
      </div>

      <div className="relative z-10">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
            style={{ background: module.color ? `${module.color}` : accentGradient(module.api_name) }}>
            <ModuleIcon name={module.icon} className="w-5 h-5" />
          </div>
          <div>
            <h1 className="t-page-title">{pluralLabel}</h1>
            {module.description && <p className="text-sm text-slate-500 mt-1">{module.description}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          {!!module.has_pipeline && (
            <button onClick={() => navigate(`/records/${module.api_name}/kanban`)}
              className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white inline-flex items-center gap-2">
              <KanbanIcon className="w-4 h-4" /> Kanban
            </button>
          )}
          {can(module.api_name, 'export') && (
            <button onClick={exportCsv} className="btn btn-secondary">Export CSV</button>
          )}
          {can(module.api_name, 'create') && (
            <button onClick={() => setShowForm((s) => {
              setFieldErrors({});
              // Opening the form seeds it with each field's configured
              // default. module_fields has carried a default_value column all
              // along and nothing ever read it, so every new record started
              // blank — including Currency, which is INR for this business on
              // essentially every quotation.
              if (!s) setForm(defaultsForCreate);
              return !s;
            })} className="btn btn-primary">
              {showForm ? 'Cancel' : `+ Add ${module.singular_label}`}
            </button>
          )}
        </div>
      </div>

      {/* Total + one card per real status (real counts), then the module's
          money / date figures — one row; the cards beyond the fifth slide in
          from the right. Click a card to see only those records; click it
          again, or the total, to see all. */}
      {recordsLoaded && (records.length > 0 || serverCards) && (cardField || extras.length > 0) && (
        <StatusCards className="mt-5" fieldLabel={(cardField?.label || 'status').toLowerCase()}
          total={{ label: `Total ${pluralLabel}`, value: totalCount, icon: TotalIcon, from: accent.from, to: accent.to }}
          items={statusCards} selected={cardValue} onSelect={setCardValue}
          // Invoices are about money first: Invoiced / Collected / Outstanding
          // / Overdue stay in view, the statuses follow to the right.
          extrasFirst={module.api_name === 'invoices'}
          extras={extras.map((k) => ({
            label: k.label, value: k.value, icon: k.icon, tone: k.tone,
            active: !!k.filter && kpiFilter === k.label,
            onClick: k.filter ? () => setKpiFilter(kpiFilter === k.label ? null : k.label) : undefined,
            title: k.filter ? (kpiFilter === k.label ? 'Click again to show all' : `Show only: ${k.label}`) : undefined,
          }))} />
      )}

      <DrillBanner drill={drill} shown={drill.data ? filtered.length : undefined} noun={pluralLabel.toLowerCase()} />

      <div className="flex gap-2 mt-5 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 36 }} className="input pl-9"
            placeholder={`Search ${pluralLabel.toLowerCase()}…`}
            aria-label={`Search ${module.plural_label}`} />
        </div>
        {statusOptions.length > 0 && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="input w-auto min-w-[150px]" aria-label={`Filter by ${statusField.label || 'status'}`}>
            <option value="">All {(statusField.label || 'statuses').toLowerCase()}</option>
            {cardIsDropdown
              ? statusCards.map((o) => <option key={o.value} value={o.value}>{o.inactive ? `${o.label} (inactive)` : o.label}</option>)
              : statusOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <FilterButton count={conditions.filter(isComplete).length} open={showFilters} onClick={() => setShowFilters((v) => !v)} />
        <SavedFiltersMenu module={module.api_name} refreshKey={savedRefresh} activeId={activeSaved?.id}
          onSelect={(f) => { setActiveSaved(f); setConditions(f ? f.filters : []); setMatch(f ? f.match : 'all'); setShowFilters(false); }} />
      </div>

      {showFilters && (
        <FilterPanel key={activeSaved?.id || 'adhoc'} module={module.api_name} fields={filterFields}
          initial={conditions} initialMatch={match} rows={records} getValue={getFieldValue}
          onClose={() => setShowFilters(false)}
          onSaved={() => setSavedRefresh((n) => n + 1)}
          onApply={(conds, m, saved) => { setConditions(conds); setMatch(m); setActiveSaved(saved || null); setShowFilters(false); }} />
      )}
      <ActiveFilterChips conditions={conditions} match={match} fields={filterFields} savedName={activeSaved?.name}
        onRemove={(c) => { setConditions((cs) => cs.filter((x) => x !== c)); setActiveSaved(null); }}
        onClear={() => { setConditions([]); setActiveSaved(null); }} />

      <BulkBar count={selection.ids.size} pageCount={pageIds.length} matchingCount={filtered.length} allPageSelected={pageSelected}
        onSelectAllMatching={() => selection.replace(filtered.map((r) => r.id))} onClear={selection.clear}
        canEdit={canEdit} canDelete={can(module.api_name, 'delete')} canExport={can(module.api_name, 'export')}
        hasUserField={userFields.length > 0}
        onUpdate={() => setBulk('update')} onAssign={() => setBulk('assign')} onExport={exportSelected} onDelete={() => setBulk('delete')} />

      {showForm && (
        <form onSubmit={submit} className="card p-5 mt-5 grid grid-cols-2 gap-4">
          {createFields.map((f) => (
            <div key={f.id} className={f.field_type === 'textarea' ? 'col-span-2' : ''}>
              <label className="text-xs text-slate-500 font-medium block mb-1">
                {f.label}
                {f.required ? <span style={{ color: 'var(--color-danger)' }}> *</span> : null}
              </label>
              <div className={fieldErrors[f.api_name] ? 'rounded-lg' : ''}
                style={fieldErrors[f.api_name] ? { boxShadow: '0 0 0 2px var(--color-danger)' } : undefined}>
                <FieldInput field={f} value={form[f.api_name]}
                  values={form} isNew onSet={(k, v) => setForm((p) => ({ ...p, [k]: v }))}
                  onChange={(v) => {
                    setForm((p) => ({ ...p, [f.api_name]: v }));
                    // Clear the error as soon as they start fixing it —
                    // leaving it red while they type reads as broken.
                    if (fieldErrors[f.api_name]) {
                      setFieldErrors((prev) => { const n = { ...prev }; delete n[f.api_name]; return n; });
                    }
                  }} />
              </div>
              {fieldErrors[f.api_name] && (
                <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{fieldErrors[f.api_name]}</p>
              )}
            </div>
          ))}
          {isProducts && (
            <div className="col-span-2">
              <label className="text-xs text-slate-500 font-medium block mb-1">Product photo</label>
              <PhotoChooser value={newPhoto} onChange={setNewPhoto} disabled={saving} />
            </div>
          )}
          {isQuotations && (
            <QuotationItemsEditor
              items={quoteItems} setItems={setQuoteItems}
              discountType={discountType} setDiscountType={setDiscountType}
              discountValue={discountValue} setDiscountValue={setDiscountValue}
            />
          )}
          <button type="submit" disabled={saving} className="col-span-2 bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : `Save ${singularLabel.toLowerCase()}`}
          </button>
        </form>
      )}

      <div className="card mt-6 overflow-hidden overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b-2" style={{ background: `${accent.solid}0D`, borderColor: `${accent.solid}33` }}>
              <th className="py-3 pl-4 pr-1 w-8">
                <RowCheckbox checked={pageSelected} indeterminate={!pageSelected && somePageSelected}
                  label="Select all on this page" onChange={() => selection.setMany(pageIds, !pageSelected)} />
              </th>
              {listFields.map((f) => <th key={f.id} className="py-3 px-4 font-medium">{fieldLabel(f)}</th>)}
              {listFields.length === 0 && <th className="py-3 px-4 font-medium">Record</th>}
              {/* A deal's stage is not one of its fields, so it gets its own
                  column — the cards above count it, the rows should show it. */}
              {cardField?.virtual && <th className="py-3 px-4 font-medium">{cardField.label}</th>}
              {followupField && <th className="py-3 px-4 font-medium">Follow-up</th>}
              {module.api_name === 'accounts' && (
                <>
                  <th className="py-3 px-4 t-meta font-semibold text-right">Contacts</th>
                  <th className="py-3 px-4 t-meta font-semibold text-right">Open deals</th>
                  <th className="py-3 px-4 t-meta font-semibold text-right">Pipeline</th>
                  <th className="py-3 px-4 t-meta font-semibold text-right"></th>
                </>
              )}
              {can(module.api_name, 'edit') && <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.id} className="border-b border-line/60 transition-colors cursor-pointer"
                onMouseEnter={(e) => { e.currentTarget.style.background = `${accent.solid}0A`; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                onClick={() => navigate(`/records/${module.api_name}/${r.id}`, { state: { preview: { id: r.id, title: recordTitle(r, fields) } } })}
                data-href={`/records/${module.api_name}/${r.id}`}
                style={selection.has(r.id) ? { background: `${accent.solid}0F` } : undefined}>
                <td className="py-3 pl-4 pr-1 w-8" onClick={(e) => e.stopPropagation()}>
                  <RowCheckbox checked={selection.has(r.id)} label={`Select ${recordTitle(r, fields)}`} onChange={() => selection.toggle(r.id)} />
                </td>
                {listFields.length > 0 ? listFields.map((f, i) => (
                  <td key={f.id} className="py-3 px-4">
                    {i === 0 ? (
                      // An initials chip on the primary column. The first
                      // cell was plain text with nothing to anchor the eye,
                      // which is a large part of why the table read as flat.
                      // Deterministic per record name, in the module accent.
                      <Link to={`/records/${module.api_name}/${r.id}`} onClick={(e) => e.stopPropagation()}
                        state={{ preview: { id: r.id, title: recordTitle(r, fields) } }}
                        className="flex items-center gap-2.5 group">
                        {isProducts && r.thumb_url ? (
                          <ProductThumb url={r.thumb_url} size={32} rounded="rounded-lg" alt="" />
                        ) : (
                          <span className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow-sm"
                            style={{ background: avatarGradientFor(formatFieldValue(getFieldValue(r, f), f)) }}>
                            {initialsOf(formatFieldValue(getFieldValue(r, f), f))}
                          </span>
                        )}
                        <span className="text-ink font-medium group-hover:text-[var(--color-brand)] truncate">
                          {formatFieldValue(getFieldValue(r, f), f)}
                        </span>
                      </Link>
                    ) : f.api_name === statusField?.api_name ? (
                      <StatusBadge status={getFieldValue(r, f)} />
                    ) : USER_TYPES.has(f.field_type) ? (
                      <AssignPicker value={getFieldValue(r, f)} mode={f.field_type === 'user_name' ? 'name' : 'id'}
                        label={f.label} disabled={!canEdit} onChange={reassign(r, f)} />
                    ) : (
                      <span className="text-slate-500">{renderFieldValue(r, f)}</span>
                    )}
                  </td>
                )) : (
                  <td className="py-3 px-4"><Link to={`/records/${module.api_name}/${r.id}`} className="text-ink font-medium hover:text-amber">{recordTitle(r, fields)}</Link></td>
                )}
                {cardField?.virtual && (
                  <td className="py-3 px-4 whitespace-nowrap">
                    {r[cardField.api_name]
                      ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                          style={r.stage_color ? { background: `${r.stage_color}22`, color: r.stage_color } : { background: '#F1F5F9', color: '#475569' }}>
                          {r[cardField.api_name]}
                        </span>
                      )
                      : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                )}
                {module.api_name === 'accounts' && (
                  <>
                    <td className="py-3 px-4 text-right">
                      <span className="text-slate-500 tabular-nums">{r.contact_count ?? 0}</span>
                      {r.open_ticket_count > 0 && (
                        <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}
                          title={`${r.open_ticket_count} open ticket(s)`}>
                          {r.open_ticket_count}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-500 tabular-nums">{r.open_deal_count ?? 0}</td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {r.open_pipeline_value > 0
                        ? <span className="text-ink font-semibold">₹{Number(r.open_pipeline_value).toLocaleString('en-IN')}</span>
                        : <span className="text-slate-300">—</span>}
                      {r.won_value > 0 && (
                        <div className="text-[11px]" style={{ color: 'var(--color-success)' }}>
                          ₹{Number(r.won_value).toLocaleString('en-IN')} won
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link to={`/customer-360/${r.id}`} onClick={(e) => e.stopPropagation()}
                        className="text-xs font-semibold whitespace-nowrap px-2.5 py-1.5 rounded-lg"
                        style={{ background: `${accent.solid}14`, color: accent.solid }}>
                        Customer 360 →
                      </Link>
                    </td>
                  </>
                )}
                {followupField && (
                  <td className="py-3 px-4">
                    {(() => { const s = computeFollowupStatus(getFieldValue(r, followupField)); return (
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} /> {s.label}
                      </span>
                    ); })()}
                  </td>
                )}
                {/* Edit opens the same popup as the detail page, right here —
                    no trip to the record and back to find your place in the
                    list again. Shown only to roles with edit on this module. */}
                {can(module.api_name, 'edit') && (
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button onClick={(e) => { e.stopPropagation(); setEditingId(r.id); }}
                      title={`Edit this ${singularLabel.toLowerCase()}`} aria-label={`Edit ${singularLabel.toLowerCase()}`}
                      className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-line bg-white transition-colors hover:border-[var(--color-brand-border)] hover:bg-[var(--color-brand-faint)]"
                      style={{ color: 'var(--color-ink)' }}>
                      <Pencil className="w-3.5 h-3.5" style={{ color: accent.solid }} /> Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {drill.active && drill.loading && <div className="p-4"><SkeletonRows rows={4} cols={5} /></div>}
        {!recordsLoaded && !(drill.active && drill.loading) && <div className="p-4"><SkeletonRows rows={6} cols={5} /></div>}
        {recordsLoaded && filtered.length === 0 && !(drill.active && (drill.loading || drill.error)) && (
          <div className="py-12 text-center">
            <p className="t-section mb-1">
              {drill.data
                ? `No ${pluralLabel.toLowerCase()} match these dashboard filters`
                : `No ${pluralLabel.toLowerCase()} ${q || statusFilter || cardFilter || kpiFilter ? 'match your filters' : 'yet'}`}
            </p>
            <p className="t-meta">
              {drill.data
                ? 'Nothing currently meets the criteria above — the dashboard figure is genuinely zero.'
                : q || statusFilter || cardFilter || kpiFilter
                  ? 'Try clearing the search or filter.'
                  : `Add your first ${singularLabel.toLowerCase()} to get started.`}
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line flex-wrap">
            <span className="t-meta">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
              {filtered.length !== records.length ? ` (filtered from ${records.length})` : ''}
              {fullCount !== null && fullCount > records.length
                ? ` — these are the newest ${records.length} of ${fullCount}. ${serverStatus ? 'Search' : 'Search, or choose a status card,'} to reach older ones.`
                : ''}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page === 1}
                  className="btn btn-secondary disabled:opacity-40">Previous</button>
                <span className="t-meta px-2">Page {page} of {totalPages}</span>
                <button onClick={() => setPage((n) => Math.min(totalPages, n + 1))} disabled={page === totalPages}
                  className="btn btn-secondary disabled:opacity-40">Next</button>
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {bulk === 'update' && (
        <BulkUpdateModal fields={massFields} count={selection.ids.size} noun={singularLabel.toLowerCase()}
          rows={records} getValue={getFieldValue} onRun={runUpdateMany} onClose={() => { setBulk(null); }} />
      )}
      {bulk === 'assign' && (
        <BulkAssignModal userFields={userFields} count={selection.ids.size} noun={singularLabel.toLowerCase()}
          onRun={runUpdate} onClose={() => setBulk(null)} />
      )}
      {bulk === 'delete' && (
        <BulkDeleteModal count={selection.ids.size} noun={singularLabel.toLowerCase()} onRun={runDelete} onClose={() => setBulk(null)} />
      )}

      {editingId && module.api_name === 'meetings' && (
        <ScheduleMeetingModal initial={{ meeting_id: editingId }}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); load(); }} />
      )}
      {editingId && module.api_name !== 'meetings' && (
        <UniversalRecordEditModal
          moduleApiName={module.api_name} recordId={editingId}
          module={module} fields={fields}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); load(); }} />
      )}
    </div>
  );
}
