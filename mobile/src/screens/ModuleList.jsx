/* A list of a module: search, mine only, more pages, a + to add. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Search, Phone, Inbox, ScanLine } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, qs, absolute } from '../lib/api';
import { money, niceDate, phoneFor } from '../lib/format';
import { openOutside } from '../lib/location';
import { TopBar, BottomNav, StatusBars, Loading, Empty, StatusTag } from '../components/ui';
import { iconOf, colorOf } from '../components/icons';

const remember = new Map();   // the search of each list while the app is open

export default function ModuleList() {
  const { module } = useParams();
  const { module: modOf } = useApp();
  const nav = useNavigate();
  const mod = modOf(module);
  const keep = remember.get(module) || { q: '', mine: false };
  const [q, setQ] = useState(keep.q);
  const [mine, setMine] = useState(keep.mine);
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback((p) => {
    const ticket = ++seq.current;
    if (p === 1) setRows(null);
    setMore(p > 1);
    GET(`/sfa/m/list/${module}${qs({ q, mine: mine ? 1 : '', page: p, page_size: 30 })}`)
      .then((x) => {
        if (ticket !== seq.current) return;
        setRows((old) => (p === 1 || !old ? x.rows : [...old, ...x.rows]));
        setTotal(x.total); setPage(p); setError('');
      })
      .catch((e) => { if (ticket === seq.current) { setError(e.message); if (p === 1) setRows([]); } })
      .finally(() => { if (ticket === seq.current) setMore(false); });
  }, [module, q, mine]);
  useEffect(() => {
    remember.set(module, { q, mine });
    const t = setTimeout(() => load(1), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, module, q, mine]);

  if (!mod) return <div className="screen"><TopBar title="Not in the app" /><Empty title="Your role cannot open this." /><BottomNav /></div>;
  const Icon = iconOf(module);
  return (
    <div className="screen">
      <TopBar title={mod.plural} sub={rows ? `${total} ${total === 1 ? mod.singular.toLowerCase() : mod.plural.toLowerCase()}` : ''}
        right={['leads', 'contacts', 'accounts'].includes(module) && mod.can.create ? <button type="button" className="icon-btn" aria-label="Scan a visiting card" onClick={() => nav('/scan-card')} data-testid="list-scan"><ScanLine size={21} /></button> : null} />
      <StatusBars />
      <div className="body">
        <div className="search"><Search size={18} /><input className="input" type="search" placeholder={`Search ${mod.plural.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="list-search" /></div>
        {module !== 'products' && (
          <div className="chips">
            <button type="button" className={`chip${!mine ? ' on' : ''}`} onClick={() => setMine(false)}>All I can see</button>
            <button type="button" className={`chip${mine ? ' on' : ''}`} onClick={() => setMine(true)} data-testid="list-mine">Mine</button>
          </div>
        )}
        {error && <div className="note bad">{error}</div>}
        {!rows ? <Loading /> : !rows.length ? (
          <Empty icon={Inbox} title={q ? 'Nothing found' : `No ${mod.plural.toLowerCase()} yet`} />
        ) : (
          <div className="list" data-testid="list">
            {rows.map((r) => (
              <div key={r.id} className="row" data-testid="list-row">
                {r.thumb_url ? <img className="thumb" src={absolute(r.thumb_url)} alt="" loading="lazy" />
                  : <span className="thumb" style={{ background: `${colorOf(module)}14`, color: colorOf(module) }}><Icon size={20} /></span>}
                <Link to={`/m/${module}/${r.id}`} className="main" style={{ color: 'inherit' }}>
                  <div className="title">{r.title}</div>
                  <div className="line">{[r.sub, r.date ? niceDate(r.date) : ''].filter(Boolean).join(' · ')}</div>
                </Link>
                <div className="end col" style={{ gap: 4, alignItems: 'flex-end' }}>
                  {r.amount !== null && r.amount !== undefined && <span className="strong" style={{ color: 'var(--ink)' }}>{money(r.amount)}</span>}
                  <StatusTag value={r.status} />
                </div>
                {r.phone && <button type="button" className="icon-btn" aria-label="Call" onClick={() => (['leads', 'contacts', 'accounts', 'opportunities'].includes(module) && modOf('calls') && modOf('calls').can.create ? nav(`/call/${module}/${r.id}?dial=1`) : openOutside(`tel:${phoneFor(r.phone)}`))} style={{ color: 'var(--ok)' }}><Phone size={20} /></button>}
              </div>
            ))}
          </div>
        )}
        {rows && rows.length < total && (
          <button type="button" className="btn outline block" disabled={more} onClick={() => load(page + 1)} data-testid="list-more">{more ? 'Loading…' : `Show more (${total - rows.length})`}</button>
        )}
      </div>
      {mod.can.create && module !== 'products' && (
        <button type="button" className="fab" aria-label={`New ${mod.singular}`} onClick={() => nav(module === 'quotations' ? '/order/new' : `/m/${module}/new`)} data-testid="fab-new"><Plus size={26} /></button>
      )}
      <BottomNav />
    </div>
  );
}
