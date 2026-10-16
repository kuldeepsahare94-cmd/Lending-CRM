/*
 * The plain map (Leaflet + OpenStreetMap, or the map set in Settings → Field force).
 * Used by FieldMap when the modern map cannot run (no WebGL, or the vector map
 * server cannot be reached). Same props as FieldMap.
 *
 *   markers  [{ id, lat, lng, color, text (1–3 letters on the pin), title, ring (a light circle), onClick }]
 *   lines    [{ id, points: [[lat, lng], …], color, dashed }]
 *   fitKey   when it changes, the map moves to show everything again
 *            (so a refresh every minute does not throw away where the person zoomed)
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, MapPinOff } from 'lucide-react';
import { loadLeaflet, OSM_TILES, OSM_ATTRIBUTION } from './field';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#2563EB');
const INDIA = [21.15, 79.09];

function pin(L, m) {
  const color = okColor(m.color);
  const text = esc(String(m.text || '').slice(0, 3));
  const html = `<div style="position:relative;width:30px;height:38px">
    <div style="position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>
    <div style="position:absolute;left:0;top:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:#fff;font:600 11px/1 system-ui,sans-serif">${text}</div></div>`;
  return L.divIcon({ html, className: 'icrm-pin', iconSize: [30, 38], iconAnchor: [15, 36], tooltipAnchor: [0, -32] });
}
function dot(L, m) {
  const color = okColor(m.color);
  return L.divIcon({ html: `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.4)"></div>`, className: 'icrm-dot', iconSize: [12, 12], iconAnchor: [6, 6] });
}

export default function LeafletFieldMap({ markers = [], lines = [], fitKey = '', height = 420, tilesUrl = '', attribution = '', testid = 'field-map' }) {
  const box = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(null);
  const [state, setState] = useState('loading');   // loading | ready | failed
  const [error, setError] = useState('');

  // the map itself, once
  useEffect(() => {
    let gone = false;
    loadLeaflet().then((L) => {
      if (gone || !box.current || map.current) return;
      const m = L.map(box.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: true }).setView(INDIA, 5);
      L.tileLayer(tilesUrl || OSM_TILES, { maxZoom: 19, attribution: tilesUrl ? esc(attribution) : OSM_ATTRIBUTION }).addTo(m);
      layer.current = L.layerGroup().addTo(m);
      map.current = m;
      setState('ready');
    }).catch((e) => { if (!gone) { setError(e.message); setState('failed'); } });
    return () => {
      gone = true;
      setState('loading');   // (a new map is made: what is drawn must be drawn again on it)
      // (stopped first: a map removed in the middle of a zoom animation throws in Leaflet)
      if (map.current) { const m = map.current; map.current = null; layer.current = null; fitted.current = null; try { m.stop(); m.off(); m.remove(); } catch { /* already gone */ } }
    };
  }, [tilesUrl, attribution]);

  // what is drawn on it
  useEffect(() => {
    if (state !== 'ready' || !map.current) return;
    const L = window.L;
    const g = layer.current;
    g.clearLayers();
    const all = [];
    lines.forEach((ln) => {
      const pts = (ln.points || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length < 2) return;
      L.polyline(pts, { color: okColor(ln.color), weight: 4, opacity: 0.8, dashArray: ln.dashed ? '6 8' : null }).addTo(g);
      pts.forEach((p) => all.push(p));
    });
    markers.forEach((m) => {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) return;
      if (m.ring) L.circle([m.lat, m.lng], { radius: m.ring, color: okColor(m.color), weight: 1, fillOpacity: 0.08 }).addTo(g);
      const mk = L.marker([m.lat, m.lng], { icon: m.small ? dot(L, m) : pin(L, m), title: m.title || '', riseOnHover: true, keyboard: true });
      if (m.title) {
        const tip = document.createElement('div');
        String(m.title).split('\n').forEach((line, i) => { const d = document.createElement('div'); d.textContent = line; if (i === 0) d.style.fontWeight = '600'; tip.appendChild(d); });
        mk.bindTooltip(tip, { direction: 'top' });
      }
      if (m.onClick) mk.on('click', () => m.onClick());
      mk.addTo(g);
      all.push([m.lat, m.lng]);
    });
    if (fitted.current !== fitKey) {
      fitted.current = fitKey;
      if (all.length === 1) map.current.setView(all[0], 15, { animate: false });
      else if (all.length > 1) map.current.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 16, animate: false });
    }
  }, [state, markers, lines, fitKey]);

  // a map in a box that changed size (a tab opened) must be told
  useEffect(() => {
    if (state !== 'ready' || !box.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { try { if (map.current) map.current.invalidateSize({ animate: false }); } catch { /* the map is being removed */ } });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [state]);

  return (
    <div className="relative rounded-xl overflow-hidden" style={{ height, border: '1px solid var(--color-line)', background: 'var(--color-canvas-alt)', isolation: 'isolate' }} data-testid={testid} data-state={state}>
      <div ref={box} className="absolute inset-0" style={{ zIndex: 0 }} />
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center t-meta gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the map…</div>
      )}
      {state === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center gap-2 p-6" data-testid="map-failed">
          <MapPinOff className="w-6 h-6" style={{ color: 'var(--color-faint)' }} />
          <p className="text-sm text-ink">{error}</p>
          <p className="t-meta">The lists below still show everything.</p>
        </div>
      )}
    </div>
  );
}
