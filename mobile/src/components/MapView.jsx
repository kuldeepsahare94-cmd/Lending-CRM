/*
 * The map (v1.2): a modern vector map (MapLibre + OpenFreeMap — free, no key),
 * or the map service set in Settings → Field force (a {z}/{x}/{y} address).
 * Phones without WebGL, or when the map server cannot be reached, get the plain
 * map (LeafletMap) with the same pins.
 *
 *   me       { lat, lng } — "you are here" (a blue dot that pulses)
 *   pins     [{ id, lat, lng, color, text, title, sub, onClick, openText }]
 *            tap a pin: a card slides up (title, sub, "Open" when onClick)
 *   line     [[lat, lng], …] — a route (a glowing line, start and end marked)
 *   fitKey   when it changes the map shows everything again
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, Maximize2, X, ChevronRight } from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useApp } from '../lib/app';
import LeafletMap from './LeafletMap';

const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const INDIA = [79.09, 21.15];
const okColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#4F46E5');
const okNum = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);

let glOk = null;
export function webglWorks() {
  if (glOk !== null) return glOk;
  try {
    const c = document.createElement('canvas');
    glOk = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { glOk = false; }
  return glOk;
}

/* The style: the company's own map pictures, or the free vector map. */
export function styleFor(tilesUrl, attribution) {
  if (!tilesUrl) return VECTOR_STYLE;
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [tilesUrl], tileSize: 256, maxzoom: 19, attribution: String(attribution || '') } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

function pinElement(p, onTap) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'gl-pin';
  el.style.setProperty('--pin', okColor(p.color));
  el.title = p.title || '';
  el.setAttribute('aria-label', p.title || 'Place');
  const face = document.createElement('span');
  face.className = 'gl-pin-face';
  face.textContent = String(p.text || '').slice(0, 3);
  el.appendChild(face);
  const tip = document.createElement('span');
  tip.className = 'gl-pin-tip';
  el.appendChild(tip);
  el.addEventListener('click', (e) => { e.stopPropagation(); onTap(p); });
  return el;
}
function meElement() {
  const el = document.createElement('div');
  el.className = 'gl-me';
  el.innerHTML = '<span class="gl-me-halo"></span><span class="gl-me-dot"></span>';
  return el;
}
function endElement(kind) {
  const el = document.createElement('div');
  el.className = `gl-end ${kind}`;
  return el;
}

export default function MapView(props) {
  const { me, pins = [], line = null, fitKey = '', tall = false, testid = 'map' } = props;
  const { boot } = useApp();
  const sfa = (boot && boot.sfa) || {};
  const tiles = sfa.map_tiles_url || '';
  const credit = sfa.map_attribution || '';
  const [plain, setPlain] = useState(() => !webglWorks());
  const [state, setState] = useState('loading');
  const [card, setCard] = useState(null);
  const box = useRef(null);
  const map = useRef(null);
  const lib = useRef(null);
  const marks = useRef([]);
  const fitted = useRef(null);
  const all = useRef([]);

  // the map itself (again when the company's map address changes)
  useEffect(() => {
    if (plain) return undefined;
    let gone = false; let m = null; let timer = null;
    setState('loading');
    import('maplibre-gl').then((mod) => {
      if (gone || !box.current) return;
      const maplibregl = mod.default || mod;
      lib.current = maplibregl;
      let loaded = false;
      try {
        m = new maplibregl.Map({
          container: box.current,
          style: styleFor(tiles, credit),
          center: me ? [me.lng, me.lat] : INDIA,
          zoom: me ? 14 : 4,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
          fadeDuration: 120,
        });
      } catch { setPlain(true); return; }
      if (m.touchZoomRotate) m.touchZoomRotate.disableRotation();
      map.current = m;
      const fail = () => { if (!loaded && !gone) { gone = true; setPlain(true); } };
      timer = setTimeout(fail, 15000);
      m.on('error', (e) => { if (!loaded && !(e && e.sourceId)) fail(); });
      m.on('load', () => {
        loaded = true; clearTimeout(timer);
        m.addSource('route', { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7C3AED', 'line-width': 14, 'line-opacity': 0.18, 'line-blur': 6 } });
        m.addLayer({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
        m.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 4.5, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#06B6D4', 0.5, '#4F46E5', 1, '#7C3AED'] } });
        setState('ready');
      });
      m.on('click', () => setCard(null));
    }).catch(() => { if (!gone) setPlain(true); });
    return () => {
      gone = true; clearTimeout(timer);
      marks.current.forEach((k) => k.remove()); marks.current = [];
      if (m) { try { m.remove(); } catch { /* gone */ } }
      map.current = null; fitted.current = null;
    };
  }, [tiles, credit, plain]); // eslint-disable-line react-hooks/exhaustive-deps

  // what is drawn on it
  useEffect(() => {
    const m = map.current; const gl = lib.current;
    if (plain || state !== 'ready' || !m || !gl) return;
    marks.current.forEach((k) => k.remove()); marks.current = [];
    const pts = [];
    const route = (line || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const src = m.getSource('route');
    if (src) src.setData({ type: 'FeatureCollection', features: route.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.map((p) => [p[1], p[0]]) } }] : [] });
    if (route.length > 1) {
      route.forEach((p) => pts.push([p[1], p[0]]));
      marks.current.push(new gl.Marker({ element: endElement('start') }).setLngLat([route[0][1], route[0][0]]).addTo(m));
      marks.current.push(new gl.Marker({ element: endElement('end') }).setLngLat([route[route.length - 1][1], route[route.length - 1][0]]).addTo(m));
    }
    pins.filter(okNum).forEach((p) => {
      const k = new gl.Marker({ element: pinElement(p, setCard), anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(m);
      marks.current.push(k); pts.push([p.lng, p.lat]);
    });
    if (me && okNum(me)) {
      marks.current.push(new gl.Marker({ element: meElement() }).setLngLat([me.lng, me.lat]).addTo(m));
      pts.push([me.lng, me.lat]);
    }
    all.current = pts;
    if (fitted.current !== fitKey && pts.length) { fitted.current = fitKey; showAll(false); }
  }, [state, plain, me, pins, line, fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // the card belongs to a pin that is still there
  useEffect(() => { if (card && !pins.some((p) => p.id === card.id)) setCard(null); }, [pins, card]);

  // a map in a box that changed size must be told
  useEffect(() => {
    if (plain || state !== 'ready' || !box.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { try { if (map.current) map.current.resize(); } catch { /* removed */ } });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [state, plain]);

  function showAll(animate = true) {
    const m = map.current; const gl = lib.current; const pts = all.current;
    if (!m || !gl || !pts.length) return;
    if (pts.length === 1) { m.jumpTo({ center: pts[0], zoom: 15 }); return; }
    const b = pts.reduce((bb, p) => bb.extend(p), new gl.LngLatBounds(pts[0], pts[0]));
    m.fitBounds(b, { padding: { top: 64, bottom: 36, left: 40, right: 60 }, maxZoom: 16, animate, duration: animate ? 600 : 0 });
  }

  if (plain) return <LeafletMap {...props} />;
  return (
    <div className={`map gl-map${tall ? ' tall' : ''}`} data-testid={testid} data-state={state} data-engine="vector">
      <div ref={box} className="gl-box" style={{ position: 'absolute', inset: 0 }} />
      {state === 'loading' && <div className="gl-loading"><span className="gl-shimmer" />Loading the map…</div>}
      <div className="gl-ctrl" role="group" aria-label="Map">
        <button type="button" aria-label="Zoom in" onClick={() => map.current && map.current.zoomIn()}><Plus size={18} /></button>
        <button type="button" aria-label="Zoom out" onClick={() => map.current && map.current.zoomOut()}><Minus size={18} /></button>
        <button type="button" aria-label="Show all" onClick={() => showAll(true)} data-testid={`${testid}-fit`}><Maximize2 size={16} /></button>
      </div>
      {card && (
        <div className="gl-card" data-testid={`${testid}-card`}>
          <span className="gl-card-dot" style={{ background: okColor(card.color) }}>{String(card.text || '').slice(0, 3)}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong ellipsis">{card.title || 'Place'}</div>
            {card.sub && <div className="tiny muted ellipsis">{card.sub}</div>}
          </div>
          {card.onClick && <button type="button" className="btn small primary" onClick={() => { const c = card; setCard(null); c.onClick(); }} data-testid={`${testid}-open`}>{card.openText || 'Open'}<ChevronRight size={16} /></button>}
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => setCard(null)}><X size={18} /></button>
        </div>
      )}
    </div>
  );
}
