import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { minutesColor, scoreColor, useColor, NEUTRAL_BUILDING } from '../colors.js';
import { USES, CATEGORIES } from '../data/uses.js';
import { translatePolygon, rectangleAt } from '../engine/geo.js';

const BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LEVEL_HEIGHT = 3.3; // metres per storey
const FC = (features = []) => ({ type: 'FeatureCollection', features });
const fmtMin = (m) => (m === Infinity ? '—' : `${Math.round(m)} min`);

const CURSORS = { select: '', paint: 'cell', draw: 'crosshair', drop: 'copy', path: 'crosshair', delete: 'not-allowed' };

/** Colour + height per building for the current view mode. */
function styledBuildings(buildings, metrics, viewMode) {
  return FC(buildings.map((f) => {
    const p = f.properties;
    const r = metrics?.perBuilding.get(p.id);
    let color;
    if (viewMode === 'uses') color = useColor(p.use);
    else if (viewMode === 'score') color = r && r.residents ? scoreColor(r.score) : NEUTRAL_BUILDING;
    else color = r ? minutesColor(r.minutes[viewMode]) : NEUTRAL_BUILDING;
    if (viewMode !== 'uses' && viewMode !== 'score' && USES[p.use]?.category === viewMode) color = useColor(p.use);
    return { ...f, properties: { ...p, color, h: Math.max(0, p.levels) * LEVEL_HEIGHT, flat: p.levels === 0 ? 1 : 0 } };
  }));
}

function metresPerPixel(map) {
  return (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

export default function MapView(props) {
  const { town, buildings, streets, deleted, metrics, viewMode, selected, layers, cameraTarget, apiRef, tool } = props;
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const live = useRef({});
  live.current = props; // handlers always see the latest props without re-binding
  const draft = useRef({ pts: [], cursor: null });
  const drag = useRef(null);

  // ---------- create the map once ----------
  useEffect(() => {
    const center = town.properties?.center || [-70.5452, 43.3838];
    const map = new maplibregl.Map({
      container: containerRef.current, style: BASE_STYLE, center, zoom: 15.3, pitch: 50, bearing: 0,
      antialias: true, maxPitch: 75, attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
    mapRef.current = map;
    if (import.meta.env.DEV) window.__simMap = map; // handy for debugging in the console
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'sim-popup' });
    if (apiRef) apiRef.current = {
      getBBox: () => { const b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; },
      getZoom: () => map.getZoom(),
    };

    map.on('load', () => {
      const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      map.addSource('satellite', { type: 'raster', tiles: [SATELLITE_TILES], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
      map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } }, firstSymbol);
      for (const l of map.getStyle().layers) if (/building/i.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');

      map.addSource('water', { type: 'geojson', data: FC() });
      map.addLayer({ id: 'sim-water', type: 'fill', source: 'water', paint: { 'fill-color': '#8fc1e3', 'fill-opacity': 0.85 } }, firstSymbol);

      map.addSource('streets', { type: 'geojson', data: FC(), promoteId: 'id' });
      map.addLayer({ id: 'sim-street-selected', type: 'line', source: 'streets', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ff5722', 'line-width': 10, 'line-opacity': 0.8 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({
        id: 'sim-streets', type: 'line', source: 'streets',
        paint: {
          'line-color': ['case', ['==', ['get', 'added'], true], '#00e5ff',
            ['match', ['get', 'highway'], ['footway', 'path', 'pedestrian', 'steps'], '#9ccc65', 'primary', '#f4b26a', 'secondary', '#f7d08a', '#ffffff']],
          'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 17, ['match', ['get', 'highway'], 'primary', 8, 'secondary', 6, ['footway', 'path', 'pedestrian', 'steps'], 3, 5]],
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      }, firstSymbol);
      map.addLayer({ id: 'sim-street-labels', type: 'symbol', source: 'streets', minzoom: 15, layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': 11, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } });

      map.addSource('deleted', { type: 'geojson', data: FC() });
      map.addLayer({ id: 'sim-deleted', type: 'line', source: 'deleted', paint: { 'line-color': '#ff1744', 'line-width': 2, 'line-dasharray': [2, 2] } });

      map.addSource('buildings', { type: 'geojson', data: FC(), promoteId: 'id' });
      map.addLayer({ id: 'sim-flat', type: 'fill', source: 'buildings', filter: ['==', ['get', 'flat'], 1], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.6, 'fill-outline-color': '#00000055' } }, firstSymbol);
      map.addLayer({
        id: 'sim-buildings', type: 'fill-extrusion', source: 'buildings', filter: ['==', ['get', 'flat'], 0],
        paint: {
          'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', ['boolean', ['feature-state', 'hover'], false], '#ffe082', ['get', 'color']],
          'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': true,
        },
      });
      map.addLayer({ id: 'sim-selected-outline', type: 'line', source: 'buildings', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ff5722', 'line-width': 3 } });
      map.addLayer({ id: 'sim-labels', type: 'symbol', source: 'buildings', minzoom: 16, filter: ['has', 'name'], layout: { 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': 11, 'text-font': ['Noto Sans Bold'], 'text-anchor': 'bottom', 'text-offset': [0, -0.5] }, paint: { 'text-color': '#1a237e', 'text-halo-color': '#ffffffdd', 'text-halo-width': 1.5 } });

      // the building being dragged
      map.addSource('drag', { type: 'geojson', data: FC() });
      map.addLayer({ id: 'sim-drag', type: 'fill-extrusion', source: 'drag', paint: { 'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.75 } });

      // shapes being drawn
      map.addSource('draft', { type: 'geojson', data: FC() });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['coalesce', ['get', 'color'], '#00e5ff'], 'fill-opacity': 0.45 } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#00e5ff', 'line-width': 3, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['case', ['==', ['get', 'cursor'], true], 6, 4], 'circle-color': ['case', ['==', ['get', 'snapped'], true], '#ff9100', '#00e5ff'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });

      setReady(true);
    });

    // ---------- helpers ----------
    const pickBuilding = (pt) => map.queryRenderedFeatures(pt, { layers: ['sim-buildings', 'sim-flat'] })[0];
    const pickStreet = (pt) => map.getLayer('sim-streets') && map.getLayoutProperty('sim-streets', 'visibility') !== 'none'
      ? map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: ['sim-streets'] })[0] : null;
    const tolM = (px) => px * metresPerPixel(map);

    const renderDraft = () => {
      const src = map.getSource('draft');
      if (!src) return;
      const { tool, brushUse, dropSize } = live.current;
      const { pts, cursor } = draft.current;
      const color = USES[brushUse]?.color;
      const feats = [];
      if (tool === 'drop' && cursor) {
        feats.push({ type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: rectangleAt(cursor.point, dropSize.w, dropSize.d, cursor.bearing) } });
      } else {
        const line = cursor ? [...pts, cursor.point] : pts;
        if (tool === 'draw' && line.length >= 3) feats.push({ type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [[...line, line[0]]] } });
        else if (line.length >= 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
        pts.forEach((p) => feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
        if (cursor) feats.push({ type: 'Feature', properties: { cursor: true, snapped: !!cursor.snapped }, geometry: { type: 'Point', coordinates: cursor.point } });
      }
      src.setData(FC(feats));
    };
    const clearDraft = () => { draft.current = { pts: [], cursor: null }; renderDraft(); };
    const finishDraft = () => {
      const { tool, onCreateBuilding, onCreatePath } = live.current;
      const pts = draft.current.pts;
      if (tool === 'draw' && pts.length >= 3) onCreateBuilding([...pts, pts[0]]);
      if (tool === 'path' && pts.length >= 2) onCreatePath(pts);
      clearDraft();
    };
    const addVertex = (p) => {
      const pts = draft.current.pts;
      const last = pts[pts.length - 1];
      if (last) {
        const a = map.project(last), b = map.project(p);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 5) return false; // double-click adds the same point twice
      }
      pts.push(p);
      return true;
    };
    map.__sim = { clearDraft, renderDraft, finishDraft };

    // ---------- pointer events ----------
    let hovered = null;
    const setHover = (id) => {
      if (hovered === id) return;
      if (hovered !== null) map.setFeatureState({ source: 'buildings', id: hovered }, { hover: false });
      hovered = id;
      if (id !== null) map.setFeatureState({ source: 'buildings', id }, { hover: true });
    };

    map.on('mousemove', (e) => {
      if (!map.getSource('buildings')) return;
      const { tool, snap, metrics, viewMode } = live.current;
      // dragging a building
      if (drag.current) {
        const d = drag.current;
        const px = Math.hypot(e.point.x - d.startPt.x, e.point.y - d.startPt.y);
        if (!d.moved && px < 4) return;
        if (!d.moved) {
          d.moved = true;
          const hide = ['!=', ['get', 'id'], d.id];
          map.setFilter('sim-buildings', ['all', ['==', ['get', 'flat'], 0], hide]);
          map.setFilter('sim-flat', ['all', ['==', ['get', 'flat'], 1], hide]);
          popup.remove();
        }
        d.dLon = e.lngLat.lng - d.start.lng; d.dLat = e.lngLat.lat - d.start.lat;
        map.getSource('drag').setData(FC([{ type: 'Feature', properties: { h: d.h }, geometry: { type: 'Polygon', coordinates: translatePolygon(d.coords, d.dLon, d.dLat) } }]));
        return;
      }
      if (tool === 'draw' || tool === 'path' || tool === 'drop') {
        setHover(null); popup.remove();
        const p = [e.lngLat.lng, e.lngLat.lat];
        if (tool === 'path') draft.current.cursor = snap(p, tolM(14));
        else if (tool === 'drop') draft.current.cursor = { point: p, bearing: snap(p, 80).bearing };
        else draft.current.cursor = { point: p, snapped: false };
        renderDraft();
        map.getCanvas().style.cursor = CURSORS[tool];
        return;
      }
      const f = pickBuilding(e.point);
      const s = !f && (tool === 'delete' || tool === 'select') ? pickStreet(e.point) : null;
      const isSel = f && live.current.selected?.id === f.properties.id;
      map.getCanvas().style.cursor = f || s ? (tool === 'select' ? (isSel ? 'move' : 'pointer') : CURSORS[tool]) : '';
      setHover(f ? f.id : null);
      if (f) {
        const p = f.properties;
        const r = metrics?.perBuilding.get(p.id);
        const extra = r ? (viewMode !== 'uses' && viewMode !== 'score' ? `<div>${CATEGORIES[viewMode].label}: <b>${fmtMin(r.minutes[viewMode])}</b></div>` : r.residents ? `<div>Walk score <b>${r.score}</b> · ~${r.residents} residents</div>` : '') : '';
        const hint = tool === 'select' ? (isSel ? '<div class="pp-hint">Drag to move</div>' : '') : tool === 'delete' ? '<div class="pp-hint">Click to remove</div>' : tool === 'paint' ? `<div class="pp-hint">Click to make it ${USES[live.current.brushUse]?.label}</div>` : '';
        popup.setLngLat(e.lngLat).setHTML(`<div class="pp-title">${p.name || USES[p.use]?.label || p.use}</div><div>${USES[p.use]?.label || p.use} · ${p.levels} ${p.levels === 1 ? 'storey' : 'storeys'}</div>${extra}${hint}`).addTo(map);
      } else if (s) {
        const p = s.properties;
        popup.setLngLat(e.lngLat).setHTML(`<div class="pp-title">${p.name || 'Unnamed ' + p.highway}</div><div>${p.highway}${p.sidewalk ? ' · sidewalk: ' + p.sidewalk : ''}</div>${tool === 'delete' ? '<div class="pp-hint">Click to remove</div>' : ''}`).addTo(map);
      } else popup.remove();
    });
    map.on('mouseout', () => { popup.remove(); setHover(null); if (draft.current.cursor) { draft.current.cursor = null; renderDraft(); } });

    map.on('mousedown', (e) => {
      const { tool, selected, buildings } = live.current;
      if (tool !== 'select' || !selected || selected.kind !== 'building') return;
      const f = pickBuilding(e.point);
      if (!f || f.properties.id !== selected.id) return;
      const src = buildings.find((b) => b.properties.id === selected.id);
      if (!src) return;
      e.preventDefault(); // stops the map from panning
      drag.current = { id: selected.id, start: e.lngLat, startPt: e.point, coords: src.geometry.coordinates, h: Math.max(3, src.properties.levels * LEVEL_HEIGHT), moved: false, dLon: 0, dLat: 0 };
    });
    const endDrag = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (d.moved) {
        map.setFilter('sim-buildings', ['==', ['get', 'flat'], 0]);
        map.setFilter('sim-flat', ['==', ['get', 'flat'], 1]);
        map.getSource('drag').setData(FC());
        live.current.onMove(d.id, d.dLon, d.dLat);
        map.__justDragged = true;
        setTimeout(() => { map.__justDragged = false; }, 50);
      }
    };
    map.on('mouseup', endDrag);
    window.addEventListener('mouseup', endDrag);

    map.on('click', (e) => {
      if (map.__justDragged) return;
      const { tool, onSelect, onPaint, onDelete, onDropBuilding, snap } = live.current;
      const p = [e.lngLat.lng, e.lngLat.lat];
      if (tool === 'draw') {
        const pts = draft.current.pts;
        if (pts.length >= 3) {
          const a = map.project(pts[0]);
          if (Math.hypot(a.x - e.point.x, a.y - e.point.y) < 10) { finishDraft(); return; }
        }
        addVertex(p); renderDraft(); return;
      }
      if (tool === 'path') {
        addVertex(snap(p, tolM(14)).point); renderDraft(); return;
      }
      if (tool === 'drop') { onDropBuilding(p, snap(p, 80).bearing); return; }
      const f = pickBuilding(e.point);
      const s = f ? null : pickStreet(e.point);
      if (tool === 'paint') { if (f) onPaint(f.properties.id); return; }
      if (tool === 'delete') {
        if (f) onDelete('building', f.properties.id);
        else if (s) onDelete('street', s.properties.id);
        popup.remove();
        return;
      }
      if (f) onSelect({ kind: 'building', id: f.properties.id });
      else if (s) onSelect({ kind: 'street', id: s.properties.id });
      else onSelect(null);
    });
    map.on('dblclick', (e) => {
      const { tool } = live.current;
      if (tool === 'draw' || tool === 'path') { e.preventDefault(); finishDraft(); }
    });

    const onKey = (e) => {
      const { tool, onExitTool } = live.current;
      if (!['draw', 'path', 'drop'].includes(tool)) return;
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'Enter') { e.preventDefault(); finishDraft(); }
      else if (e.key === 'Escape') { if (draft.current.pts.length) clearDraft(); else onExitTool(); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); draft.current.pts.pop(); renderDraft(); }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', endDrag);
      popup.remove();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- data sync ----------
  useEffect(() => {
    if (!ready) return;
    mapRef.current.getSource('water').setData(FC(town.features.filter((f) => f.properties.kind === 'water')));
  }, [ready, town]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current.getSource('buildings').setData(styledBuildings(buildings, metrics, viewMode));
  }, [ready, buildings, metrics, viewMode]);

  useEffect(() => { if (ready) mapRef.current.getSource('streets').setData(FC(streets)); }, [ready, streets]);
  useEffect(() => { if (ready) mapRef.current.getSource('deleted').setData(FC(deleted)); }, [ready, deleted]);

  // selection highlight (only touch the previous and new feature)
  const prevSel = useRef(null);
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (prevSel.current) map.setFeatureState({ source: 'buildings', id: prevSel.current }, { selected: false });
    const bId = selected?.kind === 'building' ? selected.id : null;
    const sId = selected?.kind === 'street' ? selected.id : null;
    if (bId) map.setFeatureState({ source: 'buildings', id: bId }, { selected: true });
    prevSel.current = bId;
    map.setFilter('sim-selected-outline', ['==', ['get', 'id'], bId || '']);
    map.setFilter('sim-street-selected', ['==', ['get', 'id'], sId || '']);
  }, [ready, selected, buildings]);

  // tool change: reset any half-drawn shape, toggle double-click zoom
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    map.__sim.clearDraft();
    if (tool === 'draw' || tool === 'path') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = CURSORS[tool] || '';
  }, [ready, tool]);

  // layers & styling
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const vis = (on) => (on ? 'visible' : 'none');
    map.setLayoutProperty('satellite', 'visibility', vis(layers.satellite));
    map.setLayoutProperty('sim-streets', 'visibility', vis(layers.streets));
    map.setLayoutProperty('sim-street-labels', 'visibility', vis(layers.streets && layers.labels));
    map.setLayoutProperty('sim-labels', 'visibility', vis(layers.labels));
    map.setLayoutProperty('sim-water', 'visibility', vis(!layers.satellite));
    map.setPaintProperty('sim-buildings', 'fill-extrusion-opacity', layers.opacity);
    map.setPaintProperty('sim-flat', 'fill-opacity', Math.min(0.75, layers.opacity * 0.7));
    map.setPaintProperty('sim-streets', 'line-opacity', layers.satellite ? 0.55 : 0.9);
    map.setLayoutProperty('sim-street-labels', 'text-font', ['Noto Sans Regular']);
  }, [ready, layers]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current.easeTo({ pitch: layers.tilt ? 50 : 0, duration: 600 });
  }, [ready, layers.tilt]);

  // camera requests from the app (e.g. after loading a town)
  useEffect(() => {
    if (!ready || !cameraTarget) return;
    const map = mapRef.current;
    if (cameraTarget.bbox) {
      const [w, s, e, n] = cameraTarget.bbox;
      map.fitBounds([[w, s], [e, n]], { padding: 30, pitch: layers.tilt ? 50 : 0, duration: 1200 });
    } else if (cameraTarget.center) {
      map.flyTo({ center: cameraTarget.center, zoom: cameraTarget.zoom ?? 15.5, duration: 1200 });
    }
  }, [ready, cameraTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="map" />;
}
