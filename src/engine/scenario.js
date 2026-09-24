// A scenario is a diff against the base town:
//   mods:  { [baseFeatureId]: { use?, levels?, name?, geometry?, highway?, sidewalk?, deleted? } }
//   added: [ feature, … ]   new buildings / paths drawn in the editor (edited in place)
// Keeping it a diff means scenarios stay small and survive re-loading the same town.

import { polygonAreaM2 } from './geo.js';
import { USES } from '../data/uses.js';

export const EMPTY_SCENARIO = Object.freeze({ mods: {}, added: [] });

/** Normalise scenarios saved by older versions ({edits}) or partial objects. */
export function normalizeScenario(s) {
  if (!s) return EMPTY_SCENARIO;
  if (s.scenario) return normalizeScenario(s.scenario);
  if (s.mods || s.added) return { mods: s.mods || {}, added: s.added || [] };
  if (s.edits) return { mods: s.edits, added: [] };
  return EMPTY_SCENARIO;
}

export function isEmptyScenario(s) {
  return !Object.keys(s.mods).length && !s.added.length;
}

export function changeCount(s) {
  return Object.keys(s.mods).length + s.added.length;
}

function applyMod(f, m) {
  const props = { ...f.properties };
  for (const k of ['use', 'levels', 'name', 'highway', 'sidewalk']) if (m[k] !== undefined) props[k] = m[k];
  let geometry = f.geometry;
  if (m.geometry) {
    geometry = m.geometry;
    if (props.kind === 'building') props.footprintM2 = Math.round(polygonAreaM2(geometry.coordinates));
  }
  return { ...f, properties: props, geometry };
}

/** Base features + scenario → current features of one kind ('building' | 'street'). */
export function applyScenario(baseFeatures, scenario, kind) {
  const out = [];
  for (const f of baseFeatures) {
    const m = scenario.mods[f.properties.id];
    if (!m) out.push(f);
    else if (!m.deleted) out.push(applyMod(f, m));
  }
  for (const f of scenario.added) if (f.properties.kind === kind) out.push(f);
  return out;
}

/** True if any street is modified/added (the walking network then has to be rebuilt). */
export function touchesStreets(scenario, baseStreetIds) {
  return scenario.added.some((f) => f.properties.kind === 'street') || Object.keys(scenario.mods).some((id) => baseStreetIds.has(id));
}

/** Return a new scenario with `patch` applied to feature `id` (base or added). */
export function patchFeature(scenario, baseById, id, patch) {
  const addedIdx = scenario.added.findIndex((f) => f.properties.id === id);
  if (addedIdx >= 0) {
    if (patch.deleted) return { ...scenario, added: scenario.added.filter((_, i) => i !== addedIdx) };
    const f = scenario.added[addedIdx];
    const props = { ...f.properties };
    for (const k of ['use', 'levels', 'name', 'highway', 'sidewalk']) if (patch[k] !== undefined) props[k] = patch[k];
    let geometry = f.geometry;
    if (patch.geometry) { geometry = patch.geometry; if (props.kind === 'building') props.footprintM2 = Math.round(polygonAreaM2(geometry.coordinates)); }
    const added = scenario.added.slice();
    added[addedIdx] = { ...f, properties: props, geometry };
    return { ...scenario, added };
  }
  const base = baseById.get(id);
  if (!base) return scenario;
  const merged = { ...(scenario.mods[id] || {}), ...patch };
  // drop keys that equal the original so reverting by hand cleans the diff
  for (const k of ['use', 'levels', 'name', 'highway', 'sidewalk']) if (merged[k] !== undefined && merged[k] === base.properties[k]) delete merged[k];
  if (merged.deleted === false) delete merged.deleted;
  const mods = { ...scenario.mods };
  if (Object.keys(merged).length) mods[id] = merged; else delete mods[id];
  return { ...scenario, mods };
}

export function revertFeature(scenario, id) {
  if (scenario.mods[id]) { const { [id]: _, ...mods } = scenario.mods; return { ...scenario, mods }; }
  return { ...scenario, added: scenario.added.filter((f) => f.properties.id !== id) };
}

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newBuilding(geometryCoords, use, name = null) {
  return {
    type: 'Feature',
    properties: { kind: 'building', id: newId('nb_'), use, levels: USES[use]?.defaultLevels ?? 1, name, footprintM2: Math.round(polygonAreaM2(geometryCoords)), added: true },
    geometry: { type: 'Polygon', coordinates: geometryCoords },
  };
}

export function newStreet(lineCoords, highway = 'footway', name = 'New path') {
  return {
    type: 'Feature',
    properties: { kind: 'street', id: newId('ns_'), name, highway, sidewalk: null, added: true },
    geometry: { type: 'LineString', coordinates: lineCoords },
  };
}

/** Human-readable list of the changes in a scenario (for the Changes panel). */
export function describeChanges(scenario, baseById) {
  const list = [];
  for (const [id, m] of Object.entries(scenario.mods)) {
    const f = baseById.get(id);
    if (!f) continue;
    const p = f.properties;
    const label = p.name || (p.kind === 'street' ? p.name || 'Street' : USES[p.use]?.label || p.use);
    const bits = [];
    if (m.deleted) bits.push('removed');
    else {
      if (m.use) bits.push(`${USES[p.use]?.label || p.use} → ${USES[m.use]?.label || m.use}`);
      if (m.levels !== undefined) bits.push(`${p.levels} → ${m.levels} storeys`);
      if (m.geometry) bits.push('moved/reshaped');
      if (m.name !== undefined) bits.push('renamed');
      if (m.highway) bits.push(`${p.highway} → ${m.highway}`);
      if (m.sidewalk !== undefined) bits.push(`sidewalk: ${m.sidewalk || 'unknown'}`);
    }
    list.push({ id, kind: p.kind, label, detail: bits.join(', ') });
  }
  for (const f of scenario.added) {
    const p = f.properties;
    list.push({ id: p.id, kind: p.kind, label: p.name || (p.kind === 'street' ? 'New path' : `New ${USES[p.use]?.label || p.use}`), detail: 'added' });
  }
  return list;
}
