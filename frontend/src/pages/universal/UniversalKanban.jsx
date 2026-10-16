import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, List as ListIcon, Columns3, Search, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import { ModuleIcon } from '../../components/moduleIcons';
import { accentFor, accentGradient } from '../../theme/moduleAccents';
import { avatarGradientFor, initialsOf } from '../../theme/avatarColors';
import { friendlyError } from '../../components/ui';

// Works for Opportunities (configurable pipeline stages) and Tickets
// (fixed status list from their own /kanban endpoint). Both return shapes
// close enough that one normalizer covers them.

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const cardTitle = (card) => card.opportunity_name || card.subject || card.title || `#${card.id}`;

export default function UniversalKanban() {
  const { moduleApiName } = useParams();
  const navigate = useNavigate();
  const [module, setModule] = useState(null);
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragCard, setDragCard] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);

  const accent = accentFor(moduleApiName);

  const load = async () => {
    const mod = await api.getModuleMeta(moduleApiName);
    setModule(mod);
    const data = await api.kanban(moduleApiName);
    if (Array.isArray(data)) {
      // Tickets shape: [{ status, cards }]
      setColumns(data.map((c) => ({ key: c.status, label: c.status, color: accent.solid, cards: c.cards })));
    } else {
      // Opportunities shape: { pipeline, stages: [{ stage, cards, total, weighted }] }
      setColumns((data.stages || []).map((s) => ({
        key: s.stage.id, label: s.stage.name, color: s.stage.color,
        cards: s.cards, total: s.total, weighted: s.weighted,
      })));
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [moduleApiName]);

  // Optimistic move: the card jumps immediately, and snaps back with an
  // error if the save fails. A card that silently stays moved while the
  // database disagrees is worse than no drag at all.
  const onDrop = async (columnKey) => {
    setDragOver(null);
    const card = dragCard;
    setDragCard(null);
    if (!card || card.__col === columnKey) return;

    const before = columns;
    setColumns((cols) => cols.map((c) => {
      if (c.key === card.__col) return { ...c, cards: c.cards.filter((x) => x.id !== card.id) };
      if (c.key === columnKey) return { ...c, cards: [...c.cards, card] };
      return c;
    }));
    setMoving(true); setError('');
    try {
      if (moduleApiName === 'opportunities') {
        await api.moveOpportunityStage(card.id, columnKey);
      } else {
        // Tickets and any other status-driven board. This was previously a
        // TODO comment, so dragging a ticket looked like it worked and
        // silently changed nothing.
        await api.universalUpdate({ api_name: moduleApiName, table_name: moduleApiName }, card.id, { status: columnKey });
      }
      await load();
    } catch (err) {
      setColumns(before);
      setError(friendlyError(err, `Could not move ${cardTitle(card)}.`).message);
    } finally {
      setMoving(false);
    }
  };

  const filtered = useMemo(() => {
    if (!q.trim()) return columns;
    const needle = q.toLowerCase();
    return columns.map((c) => ({
      ...c,
      cards: c.cards.filter((card) => `${cardTitle(card)} ${card.account_name || ''}`.toLowerCase().includes(needle)),
    }));
  }, [columns, q]);

  const totals = useMemo(() => {
    const cards = columns.flatMap((c) => c.cards);
    return {
      count: cards.length,
      value: cards.reduce((s, c) => s + (Number(c.amount) || 0), 0),
      weighted: columns.reduce((s, c) => s + (Number(c.weighted) || 0), 0),
    };
  }, [columns]);

  if (loading) return <div className="py-8 t-meta">Loading…</div>;
  if (!module) return null;

  const hasValue = columns.some((c) => c.total !== undefined);

  return (
    <div className="relative rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6">
      {/* Same background treatment as the list and detail pages, tinted by
          this module's accent — the Kanban was a bare white page, which is
          why switching views felt like leaving the product. */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${accent.solid}33 1px, transparent 0)`,
          backgroundSize: '22px 22px',
        }} />
        <div className="absolute -top-32 -right-28 w-[520px] h-[520px] rounded-full"
          style={{ background: `radial-gradient(circle, ${accent.solid}38, transparent 70%)` }} />
        <div className="absolute -bottom-36 -left-28 w-[460px] h-[460px] rounded-full"
          style={{ background: `radial-gradient(circle, ${accent.solid}2E, transparent 70%)` }} />
      </div>

      <div className="relative z-10">
        <button onClick={() => navigate(`/records/${module.api_name}`)}
          className="text-slate-500 hover:text-ink text-sm inline-flex items-center gap-1 mb-3">
          <ArrowLeft className="w-4 h-4" /> {module.plural_label}
        </button>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
              style={{ background: module.color || accentGradient(module.api_name) }}>
              <ModuleIcon name={module.icon} className="w-5 h-5" />
            </div>
            <div>
              <h1 className="t-page-title">{module.plural_label}</h1>
              <p className="text-sm text-slate-500 mt-0.5">Drag a card to another column to change its stage.</p>
            </div>
          </div>

          {/* The view toggle — previously the only way back to the list was
              a small text link, which is what made the Kanban feel like a
              dead end. */}
          <div className="flex items-center gap-1 bg-white border border-line rounded-xl p-1">
            <button onClick={() => navigate(`/records/${module.api_name}`)}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg text-slate-500 hover:text-ink">
              <ListIcon className="w-4 h-4" /> List
            </button>
            <button className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg text-white"
              style={{ background: accent.solid }}>
              <Columns3 className="w-4 h-4" /> Kanban
            </button>
          </div>
        </div>

        {/* Board totals — the list page has a KPI strip and the board had
            nothing, so the same data looked less informative here. */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-5">
          <BoardStat label="Cards on board" value={totals.count} from={accent.from} to={accent.to} />
          {hasValue && <BoardStat label="Total value" value={inr(totals.value)} from="#93C5FD" to="#1D4ED8" />}
          {hasValue && <BoardStat label="Weighted" value={inr(totals.weighted)} from="#C4B5FD" to="#6D28D9" />}
        </div>

        <div className="flex items-center gap-2 mt-4 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} className="input w-full pl-9"
              placeholder={`Search ${module.plural_label.toLowerCase()}…`} aria-label="Search board" />
          </div>
          {q && (
            <button onClick={() => setQ('')}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-line text-slate-500 hover:text-ink hover:bg-[var(--color-canvas)]">
              Clear
            </button>
          )}
          <button onClick={() => { setLoading(true); load(); }} disabled={moving}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-line text-slate-500 hover:text-ink hover:bg-[var(--color-canvas)] inline-flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-3"
            style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
        )}

        <div className="flex gap-4 overflow-x-auto thin-scroll pb-4 -mx-1 px-1 items-start">
          {filtered.map((col) => {
            const isTarget = dragOver === col.key && dragCard && dragCard.__col !== col.key;
            return (
              <section key={col.key}
                onDragOver={(e) => { if (dragCard) { e.preventDefault(); setDragOver(col.key); } }}
                onDragLeave={() => setDragOver((d) => (d === col.key ? null : d))}
                onDrop={(e) => { e.preventDefault(); onDrop(col.key); }}
                className="rounded-2xl border border-line w-[290px] shrink-0 flex flex-col bg-white/70 backdrop-blur transition-all"
                style={{
                  outline: isTarget ? `2px dashed ${col.color}` : 'none',
                  outlineOffset: '3px',
                  transform: isTarget ? 'translateY(-2px)' : 'none',
                  maxHeight: 'calc(100vh - 380px)',
                }}>
                {/* Stage colour as a solid top band, so columns are
                    distinguishable at a glance rather than by a small dot. */}
                <div className="h-1 rounded-t-2xl" style={{ background: col.color }} />
                <div className="px-4 py-3 border-b border-line">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold text-ink truncate">{col.label}</span>
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                        style={{ background: `${col.color}1A`, color: col.color }}>{col.cards.length}</span>
                    </div>
                  </div>
                  {col.total !== undefined && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-sm font-bold text-ink tabular-nums">{inr(col.total)}</span>
                      {col.weighted !== undefined && col.weighted > 0 && (
                        <span className="t-meta">· {inr(col.weighted)} weighted</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="p-3 space-y-2 overflow-y-auto thin-scroll flex-1 min-h-[140px]">
                  {col.cards.map((card) => {
                    const title = cardTitle(card);
                    const isDragging = dragCard?.id === card.id;
                    return (
                      <Link key={card.id} to={`/records/${module.api_name}/${card.id}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', String(card.id));
                          setDragCard({ ...card, __col: col.key });
                        }}
                        onDragEnd={() => { setDragCard(null); setDragOver(null); }}
                        className={`block bg-white border border-line rounded-xl p-3 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-40' : ''}`}>
                        <div className="flex items-start gap-2.5">
                          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                            style={{ background: avatarGradientFor(title) }}>
                            {initialsOf(title)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-ink leading-snug">{title}</div>
                            {card.account_name && <div className="t-meta truncate mt-0.5">{card.account_name}</div>}
                          </div>
                        </div>

                        {(card.amount !== undefined || card.probability !== undefined || card.expected_close_date) && (
                          <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-line/70">
                            {card.amount !== undefined && (
                              <span className="text-sm font-bold text-ink tabular-nums">{inr(card.amount)}</span>
                            )}
                            {card.probability !== undefined && card.probability !== null && (
                              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
                                style={{ background: `${col.color}14`, color: col.color }}>
                                {card.probability}%
                              </span>
                            )}
                          </div>
                        )}
                        {card.expected_close_date && (
                          <div className="t-meta mt-1.5">Close {String(card.expected_close_date).slice(0, 10)}</div>
                        )}
                        {card.priority && (
                          <div className="t-meta mt-1.5">{card.priority}</div>
                        )}
                      </Link>
                    );
                  })}

                  {col.cards.length === 0 && (
                    <div className="rounded-xl border border-dashed border-line py-6 text-center">
                      <p className="text-xs text-slate-300">{dragCard ? 'Drop here' : 'No cards'}</p>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Board summary tile, matching the list page's KPI treatment so the two
// views read as one module rather than two different products.
function BoardStat({ label, value, from, to }) {
  return (
    <div className="relative bg-white border border-line rounded-2xl p-4 pt-5 overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${from}, ${to})` }} />
      <div className="text-xl font-bold text-ink leading-none tabular-nums tracking-tight">{value}</div>
      <div className="text-[11px] text-slate-500 mt-2 uppercase tracking-wide font-medium">{label}</div>
    </div>
  );
}
