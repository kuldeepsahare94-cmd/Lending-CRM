/*
 * The plain map (Leaflet + map pictures from OpenStreetMap, or the map service
 * set in Settings → Field force). Used when the modern map (MapView) cannot run:
 * an old phone without WebGL, or the vector map server cannot be reached.
 *   me       { lat, lng } — a blue dot
 *   pins     [{ id, lat, lng, color, text, title, onClick }]
 *   line     [[lat, lng], …] — a route
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApp } from '../lib/app';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#3B5BFF');
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function pinIcon(p) {
  const html = `<div style="position:relative;width:30px;height:38px"><div style="position:absolute;inset:0 0 8px 0;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${okColor(p.color)};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div><div style="position:absolute;left:0;top:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:#fff;font:600 11px system-ui">${esc(String(p.text || '').slice(0, 3))}</div></div>`;
  return L.divIcon({ html, className: 'app-pin', iconSize: [30, 38], iconAnchor: [15, 36] });
}

export default function LeafletMap({ me, pins = [], line = null, fitKey = '', tall = false, testid = 'map' }) {
  const { boot } = useApp();
  const box = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(null);
  const tiles = (boot && boot.sfa && boot.sfa.map_tiles_url) || OSM;
  const credit = boot && boot.sfa && boot.sfa.map_tiles_url ? esc(boot.sfa.map_attribution || '') : '&copy; OpenStreetMap';

  useEffect(() => {
    const m = L.map(box.current, { zoomControl: false, attributionControl: true }).setView(me ? [me.lat, me.lng] : [21.15, 79.09], me ? 14 : 5);
    L.tileLayer(tiles, { maxZoom: 19, attribution: credit }).addTo(m);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { try { m.stop(); m.off(); m.remove(); } catch { /* gone */ } map.current = null; fitted.current = null; };
  }, [tiles]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current; const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const all = [];
    if (line && line.length > 1) { L.polyline(line, { color: '#3B5BFF', weight: 4, opacity: 0.8 }).addTo(g); line.forEach((p) => all.push(p)); }
    pins.forEach((p) => {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
      const mk = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: p.title || '' });
      if (p.onClick) mk.on('click', p.onClick);
      mk.addTo(g); all.push([p.lat, p.lng]);
    });
    if (me) {
      L.marker([me.lat, me.lng], { icon: L.divIcon({ html: '<div class="pin-me"></div>', className: '', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(g);
      all.push([me.lat, me.lng]);
    }
    if (fitted.current !== fitKey && all.length) {
      fitted.current = fitKey;
      if (all.length === 1) m.setView(all[0], 15, { animate: false });
      else m.fitBounds(L.latLngBounds(all), { padding: [36, 36], maxZoom: 16, animate: false });
    }
  }, [me, pins, line, fitKey]);

  return <div ref={box} className={`map${tall ? ' tall' : ''}`} data-testid={testid} />;
}
