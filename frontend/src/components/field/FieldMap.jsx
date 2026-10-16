/*
 * The map of Field team (v1.2): a modern vector map (MapLibre + OpenFreeMap —
 * free, no key), or the map pictures set in Settings → Field force
 * ({z}/{x}/{y} address). Without WebGL, or when the map server cannot be
 * reached, the plain map (LeafletFieldMap) is shown with the same pins.
 *
 *   markers  [{ id, lat, lng, color, text (1–3 letters on the pin), title (lines), ring (metres), small, onClick }]
 *   lines    [{ id, points: [[lat, lng], …], color, dashed }]
 *   fitKey   when it changes, the map moves to show everything again
 *            (so a refresh every minute does not throw away where the person zoomed)
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Maximize2 } from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import LeafletFieldMap from './LeafletFieldMap';

const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const INDIA = [79.09, 21.15];
const okColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#6C4FF7');
const okPt = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
// where the hover card sits next to a pin (its point is the pin's tip)
const PIN_OFFSET = { top: [0, 6], 'top-left': [6, 6], 'top-right': [-6, 6], bottom: [0, -46], 'bottom-left': [10, -40], 'bottom-right': [-10, -40], left: [22, -22], right: [-22, -22] };
const EMPTY = { type: 'FeatureCollection', features: [] };

let glOk = null;
function webglWorks() {
  if (glOk !== null) return glOk;
  try { const c = document.createElement('canvas'); glOk = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { glOk = false; }
  return glOk;
}
function styleFor(tilesUrl, attribution) {
  if (!tilesUrl) return VECTOR_STYLE;
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [tilesUrl], tileSize: 256, maxzoom: 19, attribution: String(attribution || '') } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}
// a circle of `metres` around a point, as a polygon
function circle(lat, lng, metres) {
  const out = [];
  const dLat = metres / 111320;
  const dLng = metres / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  for (let i = 0; i <= 48; i += 1) { const a = (i / 48) * 2 * Math.PI; out.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return out;
}
function pinElement(m) {
  const el = document.createElement('div');
  el.className = m.small ? 'icrm-dot icrm-gl-dot' : 'icrm-pin icrm-gl-pin';
  el.style.setProperty('--pin', okColor(m.color));
  if (m.title) el.setAttribute('title', String(m.title).split('\n')[0]);
  if (!m.small) {
    const face = document.createElement('span'); face.className = 'icrm-gl-face'; face.textContent = String(m.text || '').slice(0, 3);
    const tip = document.createElement('span'); tip.className = 'icrm-gl-tip';
    el.append(face, tip);
  }
  if (m.onClick) { el.style.cursor = 'pointer'; el.setAttribute('role', 'button'); el.tabIndex = 0; }
  return el;
}
function hoverCard(title) {
  const box = document.createElement('div');
  String(title).split('\n').forEach((line, i) => { const d = document.createElement('div'); d.textContent = line; d.className = i === 0 ? 'icrm-gl-hc-t' : 'icrm-gl-hc-s'; box.appendChild(d); });
  return box;
}

function VectorMap({ markers, lines, fitKey, height, tilesUrl, attribution, testid, onFail }) {
  const box = useRef(null);
  const map = useRef(null);
  const lib = useRef(null);
  const marks = useRef([]);
  const popup = useRef(null);
  const fitted = useRef(null);
  const all = useRef([]);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let gone = false; let m = null; let timer = null; let loaded = false;
    setState('loading');
    import('maplibre-gl').then((mod) => {
      if (gone || !box.current) return;
      const gl = mod.default || mod;
      lib.current = gl;
      try {
        m = new gl.Map({ container: box.current, style: styleFor(tilesUrl, attribution), center: INDIA, zoom: 4, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false, fadeDuration: 120 });
      } catch { onFail(); return; }
      if (m.touchZoomRotate) m.touchZoomRotate.disableRotation();
      m.addControl(new gl.NavigationControl({ showCompass: false }), 'top-right');
      map.current = m;
      const fail = () => { if (!loaded && !gone) { gone = true; onFail(); } };
      timer = setTimeout(fail, 15000);
      m.on('error', (e) => { if (!loaded && !(e && e.sourceId)) fail(); });
      m.on('load', () => {
        loaded = true; clearTimeout(timer);
        m.addSource('rings', { type: 'geojson', data: EMPTY });
        m.addLayer({ id: 'rings-fill', type: 'fill', source: 'rings', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 } });
        m.addLayer({ id: 'rings-line', type: 'line', source: 'rings', paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.6 } });
        m.addSource('routes', { type: 'geojson', data: EMPTY });
        m.addLayer({ id: 'routes-glow', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 14, 'line-opacity': 0.16, 'line-blur': 6 } });
        m.addLayer({ id: 'routes-case', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
        m.addLayer({ id: 'routes-solid', type: 'line', source: 'routes', filter: ['!=', ['get', 'dashed'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 } });
        m.addLayer({ id: 'routes-dashed', type: 'line', source: 'routes', filter: ['==', ['get', 'dashed'], true], layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-dasharray': [1.5, 2] } });
        setState('ready');
      });
    }).catch(() => { if (!gone) onFail(); });
    return () => {
      gone = true; clearTimeout(timer);
      marks.current.forEach((k) => k.remove()); marks.current = [];
      if (popup.current) { popup.current.remove(); popup.current = null; }
      if (m) { try { m.remove(); } catch { /* gone */ } }
      map.current = null; fitted.current = null;
    };
  }, [tilesUrl, attribution]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current; const gl = lib.current;
    if (state !== 'ready' || !m || !gl) return;
    marks.current.forEach((k) => k.remove()); marks.current = [];
    if (popup.current) { popup.current.remove(); popup.current = null; }
    const pts = [];
    const routes = []; const ends = [];
    lines.forEach((ln) => {
      const p = (ln.points || []).filter(okPt);
      if (p.length < 2) return;
      routes.push({ type: 'Feature', properties: { color: okColor(ln.color), dashed: !!ln.dashed }, geometry: { type: 'LineString', coordinates: p.map((x) => [x[1], x[0]]) } });
      p.forEach((x) => pts.push([x[1], x[0]]));
      ends.push([p[0], 'start', ln.color], [p[p.length - 1], 'end', ln.color]);
    });
    const rings = markers.filter((x) => x.ring && Number.isFinite(x.lat) && Number.isFinite(x.lng)).map((x) => ({ type: 'Feature', properties: { color: okColor(x.color) }, geometry: { type: 'Polygon', coordinates: [circle(x.lat, x.lng, Number(x.ring))] } }));
    if (m.getSource('routes')) m.getSource('routes').setData({ type: 'FeatureCollection', features: routes });
    if (m.getSource('rings')) m.getSource('rings').setData({ type: 'FeatureCollection', features: rings });
    ends.forEach(([p, kind, color]) => {
      const el = document.createElement('div'); el.className = `icrm-gl-end ${kind}`; el.style.setProperty('--pin', okColor(color));
      marks.current.push(new gl.Marker({ element: el }).setLngLat([p[1], p[0]]).addTo(m));
    });
    markers.forEach((x) => {
      if (!Number.isFinite(x.lat) || !Number.isFinite(x.lng)) return;
      const el = pinElement(x);
      const mk = new gl.Marker({ element: el, anchor: x.small ? 'center' : 'bottom' }).setLngLat([x.lng, x.lat]).addTo(m);
      if (x.title) {
        const show = () => {
          if (popup.current) popup.current.remove();
          popup.current = new gl.Popup({ closeButton: false, closeOnClick: false, offset: x.small ? 10 : PIN_OFFSET, className: 'icrm-gl-hc', maxWidth: '260px' })
            .setLngLat([x.lng, x.lat]).setDOMContent(hoverCard(x.title)).addTo(m);
        };
        el.addEventListener('mouseenter', show);
        el.addEventListener('focus', show);
        el.addEventListener('mouseleave', () => { if (popup.current) { popup.current.remove(); popup.current = null; } });
      }
      if (x.onClick) {
        el.addEventListener('click', (e) => { e.stopPropagation(); x.onClick(); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); x.onClick(); } });
      }
      marks.current.push(mk);
      pts.push([x.lng, x.lat]);
    });
    all.current = pts;
    if (fitted.current !== fitKey) { fitted.current = fitKey; showAll(false); }
  }, [state, markers, lines, fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state !== 'ready' || !box.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { try { if (map.current) map.current.resize(); } catch { /* removed */ } });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [state]);

  function showAll(animate = true) {
    const m = map.current; const gl = lib.current; const pts = all.current;
    if (!m || !gl || !pts.length) return;
    if (pts.length === 1) { m.jumpTo({ center: pts[0], zoom: 15 }); return; }
    const b = pts.reduce((bb, p) => bb.extend(p), new gl.LngLatBounds(pts[0], pts[0]));
    m.fitBounds(b, { padding: { top: 70, bottom: 40, left: 50, right: 60 }, maxZoom: 16, animate, duration: animate ? 600 : 0 });
  }

  return (
    <div className="icrm-gl-map relative rounded-2xl overflow-hidden" style={{ height, isolation: 'isolate' }} data-testid={testid} data-state={state} data-engine="vector">
      {/* (inline: the map library's own CSS makes its box "position: relative") */}
      <div ref={box} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      {state === 'loading' && <div className="absolute inset-0 flex items-center justify-center t-meta gap-2" style={{ zIndex: 2 }}><Loader2 className="w-4 h-4 animate-spin" /> Loading the map…</div>}
      {state === 'ready' && (
        <button type="button" className="icrm-gl-fit" onClick={() => showAll(true)} title="Show everything" aria-label="Show everything" data-testid={`${testid}-fit`}>
          <Maximize2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default function FieldMap(props) {
  const [plain, setPlain] = useState(() => !webglWorks());
  if (plain) return <LeafletFieldMap {...props} />;
  const { markers = [], lines = [], fitKey = '', height = 420, tilesUrl = '', attribution = '', testid = 'field-map' } = props;
  return <VectorMap markers={markers} lines={lines} fitKey={fitKey} height={height} tilesUrl={tilesUrl} attribution={attribution} testid={testid} onFail={() => setPlain(true)} />;
}
