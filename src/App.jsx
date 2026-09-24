import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from './components/MapView.jsx';
import Sidebar from './components/Sidebar.jsx';
import MetricsPanel from './components/MetricsPanel.jsx';
import { buildGraph, attachBuildings } from './engine/graph.js';
import { computeMetrics } from './engine/metrics.js';
import { makeSnapper } from './engine/snap.js';
import { planRoute } from './engine/route.js';
import { translatePolygon, transformPolygon, rectangleAt, polygonCentroid } from './engine/geo.js';
import {
  EMPTY_SCENARIO, applyScenario, patchFeature, revertFeature, newBuilding, newStreet,
  describeChanges, changeCount, normalizeScenario,
} from './engine/scenario.js';
import { generateTown } from './data/generateTown.js';
import { fetchTownBBox, geocode, KENNEBUNK_BBOX, DATA_VERSION } from './data/osm.js';
import { loadCachedTown, cacheTown, clearCachedTown } from './data/townStore.js';
import { useScenarios } from './hooks/useScenarios.js';

const HISTORY_LIMIT = 100;
const MAX_AREA_KM2 = 30;

function bboxAreaKm2([w, s, e, n]) {
  return ((e - w) * 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180)) * ((n - s) * 110.54);
}
const townKeyOf = (t) => t?.properties?.key || (t?.properties?.source === 'generated' ? 'generated' : t?.properties?.name || 'town');

export default function App() {
  const [town, setTown] = useState(null);
  const [townStatus, setTownStatus] = useState(null); // {loading, message, error}
  const [hist, setHist] = useState({ past: [], present: EMPTY_SCENARIO, future: [] });
  const [selected, setSelected] = useState(null);     // {kind: 'building'|'street', id}
  const [tool, setTool] = useState('select');         // select | paint | draw | drop | path | route | delete
  const [routePts, setRoutePts] = useState([]);       // waypoints of the planned walking route
  const [walk, setWalk] = useState(null);             // {active, withRoute, pos?, heading?, at}
  const [brushUse, setBrushUse] = useState('retail');
  const [dropSize, setDropSize] = useState({ w: 20, d: 14 });
  const [viewMode, setViewMode] = useState('uses');
  const [layers, setLayers] = useState({ satellite: false, tilt: true, streets: true, labels: true, opacity: 0.9 });
  const [cameraTarget, setCameraTarget] = useState(null);
  const [scenarioName, setScenarioName] = useState('');
  const [compareIds, setCompareIds] = useState([]);
  const mapApi = useRef(null);
  const scenario = hist.present;
  const townKey = townKeyOf(town);
  const scenarios = useScenarios(townKey);

  // ---------------- town loading ----------------
  const adoptTown = useCallback((t, { fit = false } = {}) => {
    setTown(t);
    setHist({ past: [], present: EMPTY_SCENARIO, future: [] });
    setSelected(null);
    setCompareIds([]);
    setScenarioName('');
    setRoutePts([]);
    setWalk(null);
    if (t.properties?.source === 'openstreetmap') setLayers((l) => ({ ...l, satellite: true, opacity: Math.min(l.opacity, 0.8) }));
    if (fit && t.properties?.bbox) setCameraTarget({ bbox: t.properties.bbox, at: Date.now() });
  }, []);

  const loadRealTown = useCallback(async (bbox, name, { fit = false } = {}) => {
    const area = bboxAreaKm2(bbox);
    if (area > MAX_AREA_KM2) {
      setTownStatus({ error: true, message: `That view is ${Math.round(area)} km² — zoom in to under ${MAX_AREA_KM2} km² and try again.` });
      return;
    }
    setTownStatus({ loading: true, message: `Downloading streets, businesses and building footprints for ${name}…` });
    let note = '';
    try {
      const t = await fetchTownBBox(bbox, { name, onProgress: (m) => { note = m; } });
      const n = t.features.filter((f) => f.properties.kind === 'building').length;
      if (!n) throw new Error('No buildings mapped in this area.');
      adoptTown(t, { fit });
      cacheTown(t);
      const src = t.properties.footprints ? 'footprints from FEMA USA Structures, streets and businesses from OpenStreetMap' : 'from OpenStreetMap';
      setTownStatus({ message: `Loaded ${n.toLocaleString()} buildings (${src}).${note ? ' ' + note : ''}` });
    } catch (e) {
      setTownStatus({ error: true, message: `Couldn't load real data: ${e.message}. Still showing the previous layout.` });
    }
  }, [adoptTown]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await loadCachedTown();
      if (cancelled) return;
      if (cached) {
        adoptTown(cached);
        // refresh towns saved by an older version of the loader
        if (cached.properties?.dataVersion !== DATA_VERSION && cached.properties?.bbox) loadRealTown(cached.properties.bbox, cached.properties.name);
        return;
      }
      let t = null;
      try { const r = await fetch(`${import.meta.env.BASE_URL}data/town.json`); if (r.ok) t = await r.json(); } catch { /* none */ }
      if (cancelled) return;
      if (t && t.properties?.source !== 'generated') { adoptTown(t); return; }
      adoptTown(t || generateTown());
      loadRealTown(KENNEBUNK_BBOX, 'Kennebunk, Maine', { fit: true }); // first run: swap the stand-in for the real town
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCurrentView = useCallback(() => {
    const bbox = mapApi.current?.getBBox();
    if (bbox) loadRealTown(bbox, town?.properties?.source === 'openstreetmap' ? town.properties.name : 'Custom area');
  }, [loadRealTown, town]);

  const searchPlace = useCallback(async (q) => {
    setTownStatus({ loading: true, message: `Looking up "${q}"…` });
    try {
      const hit = await geocode(q);
      const r = 1300, dLat = r / 110540, dLon = r / (111320 * Math.cos((hit.center[1] * Math.PI) / 180));
      const bbox = [hit.center[0] - dLon, hit.center[1] - dLat, hit.center[0] + dLon, hit.center[1] + dLat];
      await loadRealTown(bbox, hit.name.split(',').slice(0, 2).join(','), { fit: true });
    } catch (e) {
      setTownStatus({ error: true, message: e.message });
    }
  }, [loadRealTown]);

  const useStandIn = useCallback(() => { clearCachedTown(); adoptTown(generateTown(), {}); setCameraTarget({ center: generateTown().properties.center, zoom: 15.3, at: Date.now() }); setTownStatus(null); setLayers((l) => ({ ...l, satellite: false })); }, [adoptTown]);

  const downloadTown = useCallback(() => {
    const blob = new Blob([JSON.stringify(town)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'town.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [town]);

  // ---------------- derived data ----------------
  const baseBuildings = useMemo(() => town?.features.filter((f) => f.properties.kind === 'building') ?? [], [town]);
  const baseStreets = useMemo(() => town?.features.filter((f) => f.properties.kind === 'street') ?? [], [town]);
  const baseById = useMemo(() => new Map([...baseBuildings, ...baseStreets].map((f) => [f.properties.id, f])), [baseBuildings, baseStreets]);
  const baseStreetIds = useMemo(() => new Set(baseStreets.map((f) => f.properties.id)), [baseStreets]);

  // Only rebuild the walking network when the street part of the scenario changes.
  const streetPartRef = useRef(null);
  const streetPart = useMemo(() => {
    const mods = Object.entries(scenario.mods).filter(([id]) => baseStreetIds.has(id));
    const added = scenario.added.filter((f) => f.properties.kind === 'street');
    const prev = streetPartRef.current;
    const same = prev && prev.base === baseStreets && prev.mods.length === mods.length && prev.added.length === added.length
      && mods.every(([id, m], i) => prev.mods[i][0] === id && prev.mods[i][1] === m) && added.every((f, i) => prev.added[i] === f);
    if (same) return prev;
    return (streetPartRef.current = { base: baseStreets, mods, added });
  }, [scenario, baseStreetIds, baseStreets]);

  const streets = useMemo(
    () => (streetPart.mods.length || streetPart.added.length ? applyScenario(baseStreets, { mods: Object.fromEntries(streetPart.mods), added: streetPart.added }, 'street') : baseStreets),
    [streetPart, baseStreets],
  );
  const buildings = useMemo(() => applyScenario(baseBuildings, scenario, 'building'), [baseBuildings, scenario]);

  const graphCaches = useRef(new WeakMap());
  const cacheFor = (g) => { let c = graphCaches.current.get(g); if (!c) graphCaches.current.set(g, (c = new WeakMap())); return c; };
  const baseGraph = useMemo(() => (town ? buildGraph(baseStreets) : null), [town, baseStreets]);
  const graph = useMemo(() => (streets === baseStreets ? baseGraph : buildGraph(streets)), [streets, baseStreets, baseGraph]);

  const metrics = useMemo(() => (graph ? computeMetrics(graph, attachBuildings(graph, buildings, cacheFor(graph)), buildings) : null), [graph, buildings]);
  const baseMetrics = useMemo(() => (baseGraph ? computeMetrics(baseGraph, attachBuildings(baseGraph, baseBuildings, cacheFor(baseGraph)), baseBuildings) : null), [baseGraph, baseBuildings]);
  const snap = useMemo(() => makeSnapper(streets), [streets]);
  const streetById = useMemo(() => new Map(streets.map((f) => [f.properties.id, f])), [streets]);

  // Planned walking route on the current layout, and the same trip on today's layout for comparison.
  const route = useMemo(() => planRoute(graph, streets, routePts, snap), [graph, streets, routePts, snap]);
  const baseSnap = useMemo(() => (streets === baseStreets ? snap : makeSnapper(baseStreets)), [streets, baseStreets, snap]);
  const baseRoute = useMemo(() => (graph === baseGraph ? route : planRoute(baseGraph, baseStreets, routePts, baseSnap)), [graph, baseGraph, baseStreets, routePts, route, baseSnap]);

  const deleted = useMemo(() => Object.entries(scenario.mods).filter(([, m]) => m.deleted).map(([id]) => baseById.get(id)).filter(Boolean), [scenario, baseById]);
  const changes = useMemo(() => describeChanges(scenario, baseById), [scenario, baseById]);

  // ---------------- editing ----------------
  // `key` merges rapid edits of the same field (typing a name) into one undo step
  const lastCommit = useRef({ key: null, at: 0 });
  const commit = useCallback((fn, key = null) => {
    const now = Date.now();
    const merge = key && lastCommit.current.key === key && now - lastCommit.current.at < 1500;
    lastCommit.current = { key, at: now };
    setHist((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      if (merge) return { ...h, present: next, future: [] };
      return { past: [...h.past.slice(-HISTORY_LIMIT + 1), h.present], present: next, future: [] };
    });
  }, []);
  const undo = useCallback(() => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)), []);
  const redo = useCallback(() => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)), []);

  const findFeature = useCallback((id) => buildings.find((f) => f.properties.id === id) || streets.find((f) => f.properties.id === id), [buildings, streets]);

  const editFeature = useCallback((id, patch) => {
    const typing = 'name' in patch || 'levels' in patch;
    commit((s) => patchFeature(s, baseById, id, patch), typing ? `${id}:${Object.keys(patch).join()}` : null);
  }, [commit, baseById]);
  const paint = useCallback((id) => editFeature(id, { use: brushUse }), [editFeature, brushUse]);
  const remove = useCallback((kind, id) => {
    commit((s) => patchFeature(s, baseById, id, { deleted: true }));
    setSelected((sel) => (sel?.id === id ? null : sel));
  }, [commit, baseById]);
  const move = useCallback((id, dLon, dLat) => {
    const f = findFeature(id);
    if (f) editFeature(id, { geometry: { type: 'Polygon', coordinates: translatePolygon(f.geometry.coordinates, dLon, dLat) } });
  }, [findFeature, editFeature]);
  const transform = useCallback((id, t) => {
    const f = findFeature(id);
    if (f) editFeature(id, { geometry: { type: 'Polygon', coordinates: transformPolygon(f.geometry.coordinates, t) } });
  }, [findFeature, editFeature]);
  const addFeature = useCallback((f) => { commit((s) => ({ ...s, added: [...s.added, f] })); setSelected({ kind: f.properties.kind, id: f.properties.id }); }, [commit]);
  const createBuilding = useCallback((ring) => addFeature(newBuilding([ring], brushUse)), [addFeature, brushUse]);
  const dropBuilding = useCallback((p, bearing) => addFeature(newBuilding(rectangleAt(p, dropSize.w, dropSize.d, bearing), brushUse)), [addFeature, brushUse, dropSize]);
  const createPath = useCallback((line) => addFeature(newStreet(line)), [addFeature]);
  const duplicate = useCallback((id) => {
    const f = findFeature(id);
    if (!f || f.properties.kind !== 'building') return;
    const dLon = 18 / (111320 * Math.cos((f.geometry.coordinates[0][0][1] * Math.PI) / 180));
    const copy = newBuilding(translatePolygon(f.geometry.coordinates, dLon, 0), f.properties.use, f.properties.name ? `${f.properties.name} (copy)` : null);
    copy.properties.levels = f.properties.levels;
    addFeature(copy);
  }, [findFeature, addFeature]);
  const revert = useCallback((id) => commit((s) => revertFeature(s, id)), [commit]);
  const resetAll = useCallback(() => { commit(() => EMPTY_SCENARIO); setSelected(null); }, [commit]);

  const chooseTool = useCallback((t) => { setTool(t); if (t !== 'select') setSelected(null); }, []);

  // ---------------- route planning & walk mode ----------------
  const addRoutePt = useCallback((p) => setRoutePts((pts) => [...pts, p]), []);
  const popRoutePt = useCallback(() => setRoutePts((pts) => pts.slice(0, -1)), []);
  const clearRoute = useCallback(() => setRoutePts([]), []);
  /** Use a building as a route stop: its front door is taken as the nearest point on a street. */
  const routeFromBuilding = useCallback((f) => {
    if (f?.properties.kind !== 'building') return;
    setRoutePts((pts) => [...pts, snap(polygonCentroid(f.geometry.coordinates), 80).point]);
    chooseTool('route');
  }, [snap, chooseTool]);
  const startWalk = useCallback((withRoute) => {
    if (withRoute && !route) return;
    setSelected(null);
    if (!withRoute && tool !== 'select') setTool('select');
    setWalk({ active: true, withRoute, at: Date.now() });
  }, [route, tool]);
  const endWalk = useCallback(() => setWalk(null), []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (walk?.active) return; // the walker owns the keyboard (WASD, Esc)
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      if (tool === 'select' && selected && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); remove(selected.kind, selected.id); return; }
      if (tool === 'select' && e.key === 'Escape') { setSelected(null); return; }
      const keys = { v: 'select', p: 'paint', b: 'draw', d: 'drop', f: 'path', r: 'route', x: 'delete' };
      if (keys[e.key.toLowerCase()] && !['draw', 'path'].includes(tool)) chooseTool(keys[e.key.toLowerCase()]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, selected, undo, redo, remove, chooseTool, walk]);

  // ---------------- scenarios ----------------
  const loadScenario = useCallback((s) => { commit(() => normalizeScenario(s)); setSelected(null); setScenarioName(s.name); if (Array.isArray(s.route) && s.route.length >= 2) setRoutePts(s.route); }, [commit]);
  const saveScenario = useCallback(() => {
    const s = scenarios.save(scenarioName.trim(), scenario, metrics.summary, routePts);
    setScenarioName(s.name);
    setCompareIds((ids) => [...ids, s.id]);
  }, [scenarios, scenarioName, scenario, metrics, routePts]);
  const exportScenarios = useCallback(() => {
    const blob = new Blob([JSON.stringify({ town: town?.properties?.name, townKey, scenarios: scenarios.scenarios }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'walkability-scenarios.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [scenarios, town, townKey]);
  const importScenarios = useCallback((file) => {
    file.text().then((t) => { const j = JSON.parse(t); scenarios.importAll(Array.isArray(j) ? j : j.scenarios || []); }).catch(() => setTownStatus({ error: true, message: 'Could not read that scenarios file.' }));
  }, [scenarios]);

  if (!town) return <div className="loading">Loading town…</div>;

  const selectedFeature = selected ? findFeature(selected.id) : null;

  return (
    <div className="app">
      <Sidebar
        town={town} townStatus={townStatus} buildingCount={buildings.length}
        onSearchPlace={searchPlace} onLoadView={loadCurrentView} onUseStandIn={useStandIn} onDownloadTown={downloadTown}
        tool={tool} setTool={chooseTool} brushUse={brushUse} setBrushUse={setBrushUse} dropSize={dropSize} setDropSize={setDropSize}
        canUndo={hist.past.length > 0} canRedo={hist.future.length > 0} onUndo={undo} onRedo={redo}
        selected={selectedFeature} selectedResult={selectedFeature?.properties.kind === 'building' ? metrics?.perBuilding.get(selectedFeature.properties.id) : null}
        isChanged={selectedFeature ? !!scenario.mods[selectedFeature.properties.id] || !!selectedFeature.properties.added : false}
        onEdit={editFeature} onTransform={transform} onDuplicate={duplicate} onDelete={remove} onRevert={revert} onDeselect={() => setSelected(null)}
        changes={changes} onSelectChange={(c) => { if (!c.detail.includes('removed')) setSelected({ kind: c.kind, id: c.id }); }} onResetAll={resetAll}
        metrics={metrics} viewMode={viewMode} setViewMode={setViewMode} layers={layers} setLayers={setLayers}
        routePts={routePts} route={route} baseRoute={baseRoute} onClearRoute={clearRoute} onPopRoutePt={popRoutePt} onRouteFromBuilding={routeFromBuilding}
        walking={!!walk?.active} onWalk={startWalk} onEndWalk={endWalk}
      />
      <MapView
        town={town} buildings={buildings} streets={streets} deleted={deleted} metrics={metrics} viewMode={viewMode}
        selected={selected} onSelect={setSelected} tool={tool} brushUse={brushUse} dropSize={dropSize} snap={snap}
        onPaint={paint} onDelete={remove} onMove={move} onCreateBuilding={createBuilding} onDropBuilding={dropBuilding} onCreatePath={createPath}
        onExitTool={() => setTool('select')} layers={layers} cameraTarget={cameraTarget} apiRef={mapApi}
        routePts={routePts} route={route} baseRoute={baseRoute} onAddRoutePt={addRoutePt} onRoutePop={popRoutePt} onRouteClear={clearRoute}
        walk={walk} onWalkEnd={endWalk} streetById={streetById}
      />
      <MetricsPanel
        metrics={metrics} baseMetrics={baseMetrics} editCount={changeCount(scenario)}
        scenarioName={scenarioName} setScenarioName={setScenarioName} onSave={saveScenario}
        scenarios={scenarios.scenarios} onLoad={loadScenario}
        onDelete={(id) => { scenarios.remove(id); setCompareIds((ids) => ids.filter((x) => x !== id)); }}
        onRename={scenarios.rename} compareIds={compareIds} setCompareIds={setCompareIds}
        onExport={exportScenarios} onImport={importScenarios} onShowCategory={setViewMode} viewMode={viewMode}
      />
    </div>
  );
}
