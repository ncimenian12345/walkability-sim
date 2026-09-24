// Walkability metrics for a scenario.
//
// For every amenity category we run one multi-source Dijkstra from all buildings
// that provide it; that yields the network walking distance from every street
// node to the nearest provider. Each building then gets:
//   minutes[cat]  — walk time to the nearest provider of each category
//   score         — 0–100 Walk-Score-style index (distance-decayed, weighted)
// and the town gets population-weighted summaries.

import { CATEGORIES, CATEGORY_KEYS, USES, WALK_SPEED_M_PER_MIN, FIFTEEN_MIN_M, estimateResidents, isResidential } from '../data/uses.js';
import { multiSourceDijkstra } from './dijkstra.js';

const MAX_SEARCH_M = 2600;

/** Walk Score-style distance decay: full credit ≤400 m, ~12% at 1600 m, 0 at 2400 m. */
export function decay(d) {
  if (d <= 400) return 1;
  if (d <= 1600) return 1 - 0.88 * ((d - 400) / 1200);
  if (d <= 2400) return 0.12 * (1 - (d - 1600) / 800);
  return 0;
}

/**
 * @param graph      pedestrian graph from buildGraph
 * @param attach     Map buildingId -> {node, offset} from attachBuildings
 * @param buildings  array of building features (current scenario)
 */
export function computeMetrics(graph, attach, buildings) {
  // 1. Sources per category
  const sources = {};
  for (const k of CATEGORY_KEYS) sources[k] = [];
  const useCounts = {};
  for (const f of buildings) {
    const p = f.properties;
    useCounts[p.use] = (useCounts[p.use] || 0) + 1;
    const cat = USES[p.use]?.category;
    if (!cat) continue;
    const a = attach.get(p.id);
    if (a) sources[cat].push([a.node, a.offset]);
  }

  // 2. One Dijkstra per category
  const distByCat = {};
  for (const k of CATEGORY_KEYS) {
    distByCat[k] = sources[k].length ? multiSourceDijkstra(graph, sources[k], MAX_SEARCH_M) : null;
  }

  // 3. Per-building results
  const totalWeight = CATEGORY_KEYS.reduce((s, k) => s + CATEGORIES[k].weight, 0);
  const essentials = CATEGORY_KEYS.filter((k) => CATEGORIES[k].essential);
  const perBuilding = new Map();
  let population = 0, weightedScore = 0, allEssentialsPop = 0;
  const coveredPop = {};
  for (const k of CATEGORY_KEYS) coveredPop[k] = 0;

  for (const f of buildings) {
    const p = f.properties;
    const a = attach.get(p.id);
    // Use FEMA's per-building population estimate while the building is unchanged
    const residents = p.pop != null && p.use === p.origUse && p.levels === p.origLevels && isResidential(p.use)
      ? Math.max(1, p.pop)
      : estimateResidents(p.use, p.footprintM2, p.levels);
    const minutes = {};
    let score = 0;
    for (const k of CATEGORY_KEYS) {
      const d = distByCat[k] && a ? distByCat[k][a.node] + a.offset : Infinity;
      minutes[k] = d === Infinity ? Infinity : d / WALK_SPEED_M_PER_MIN;
      score += CATEGORIES[k].weight * decay(d);
      if (residents && d <= FIFTEEN_MIN_M) coveredPop[k] += residents;
    }
    score = Math.round((100 * score) / totalWeight);
    const hasAllEssentials = essentials.every((k) => minutes[k] * WALK_SPEED_M_PER_MIN <= FIFTEEN_MIN_M);
    perBuilding.set(p.id, { score, minutes, residents, hasAllEssentials });
    if (residents) {
      population += residents;
      weightedScore += residents * score;
      if (hasAllEssentials) allEssentialsPop += residents;
    }
  }

  const coverage = {};
  for (const k of CATEGORY_KEYS) {
    coverage[k] = { providers: sources[k].length, residents: coveredPop[k], share: population ? coveredPop[k] / population : 0 };
  }

  const amenityBuildings = buildings.filter((f) => USES[f.properties.use]?.category).length;
  const homes = buildings.filter((f) => isResidential(f.properties.use)).length;

  return {
    perBuilding,
    summary: {
      population,
      homes,
      amenityBuildings,
      avgScore: population ? Math.round(weightedScore / population) : 0,
      fifteenMinShare: population ? allEssentialsPop / population : 0,
      coverage,
      useCounts,
    },
  };
}

/** Apply a use change to a building feature, returning a new feature (immutable update). */
export function withUse(feature, use, levels) {
  const lv = levels ?? (USES[use]?.defaultLevels ?? feature.properties.levels);
  return { ...feature, properties: { ...feature.properties, use, levels: lv } };
}
