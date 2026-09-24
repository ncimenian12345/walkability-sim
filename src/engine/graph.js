// Pedestrian network built from street LineStrings.
// Nodes are snapped coordinates; edges are consecutive vertices of each street,
// weighted by length × a comfort penalty for the street type.
// Streets drawn in the editor (properties.added) have their loose ends spliced into
// whatever street segment they touch, so a new footpath joins the network.

import { fastDist, polygonCentroid } from './geo.js';

// How unpleasant a street type is to walk along (1 = neutral). Busier roads
// lengthen the walk a little; paths shorten it slightly.
export const HIGHWAY_PENALTY = {
  footway: 0.9, path: 0.9, pedestrian: 0.85, cycleway: 0.95, steps: 1.1, living_street: 0.95, track: 1.0,
  residential: 1.0, service: 1.05, unclassified: 1.05, tertiary: 1.05, secondary: 1.1, primary: 1.2, trunk: 1.6,
};
const NON_WALKABLE = new Set(['motorway', 'motorway_link', 'trunk_link']);
const SNAP = 1e-5;   // ~1 m; street ends meeting at the same point share a node
const SPLICE_M = 6;  // loose ends of drawn paths within this distance of a street join it

const keyOf = (c) => `${Math.round(c[0] / SNAP)},${Math.round(c[1] / SNAP)}`;

export function penaltyFor(props) {
  let p = HIGHWAY_PENALTY[props.highway] ?? 1.0;
  if (props.sidewalk === 'no' || props.sidewalk === 'none') p *= 1.25;
  if (['both', 'left', 'right', 'yes', 'separate'].includes(props.sidewalk)) p = Math.min(p, 1.05);
  return p;
}

export function buildGraph(streets) {
  const nodeIndex = new Map();
  const coords = [];
  const nodeOwners = []; // node -> Set of feature indices touching it
  const edges = [];      // {a, b, w, fid, alive}
  const lat0 = streets.find((f) => f.geometry.coordinates.length)?.geometry.coordinates[0][1] ?? 0;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);

  const getNode = (c, fid) => {
    const k = keyOf(c);
    let id = nodeIndex.get(k);
    if (id === undefined) {
      id = coords.length;
      nodeIndex.set(k, id);
      coords.push(c);
      nodeOwners.push(new Set());
    }
    nodeOwners[id].add(fid);
    return id;
  };

  const looseEnds = [];
  streets.forEach((f, fid) => {
    const hw = f.properties.highway || 'residential';
    if (NON_WALKABLE.has(hw)) return;
    const penalty = penaltyFor(f.properties);
    const line = f.geometry.coordinates;
    let first = -1, last = -1;
    for (let i = 1; i < line.length; i++) {
      const a = getNode(line[i - 1], fid);
      const b = getNode(line[i], fid);
      if (i === 1) first = a;
      last = b;
      if (a === b) continue;
      edges.push({ a, b, w: fastDist(line[i - 1], line[i], cosLat) * penalty, fid, alive: true });
    }
    if (f.properties.added && first >= 0) looseEnds.push([first, fid], [last, fid]);
  });

  // Splice the loose ends of drawn paths into the segment they land on
  for (const [n, fid] of looseEnds) {
    if (nodeOwners[n].size > 1) continue; // already shares a node with another street
    const p = coords[n];
    let best = null, bestD = SPLICE_M;
    for (const e of edges) {
      if (!e.alive || e.fid === fid || e.a === n || e.b === n) continue;
      const { d, t } = projectOnSegment(p, coords[e.a], coords[e.b], cosLat);
      if (d < bestD) { bestD = d; best = { e, t }; }
    }
    if (!best) continue;
    const { e, t } = best;
    e.alive = false;
    const link = bestD; // short connector from the end to the street itself
    edges.push({ a: e.a, b: n, w: e.w * t + link, fid: e.fid, alive: true });
    edges.push({ a: n, b: e.b, w: e.w * (1 - t) + link, fid: e.fid, alive: true });
    nodeOwners[n].add(e.fid);
  }

  const adj = coords.map(() => []);
  for (const e of edges) {
    if (!e.alive) continue;
    adj[e.a].push([e.b, e.w]);
    adj[e.b].push([e.a, e.w]);
  }

  // Spatial hash of connected nodes for nearest-node queries
  const CELL = 0.0015; // ~120 m
  const cells = new Map();
  coords.forEach((c, i) => {
    if (!adj[i].length) return;
    const k = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
    let arr = cells.get(k);
    if (!arr) cells.set(k, (arr = []));
    arr.push(i);
  });

  function nearestNode(c) {
    const cx = Math.floor(c[0] / CELL), cy = Math.floor(c[1] / CELL);
    let best = -1, bestD = Infinity, foundAt = -1;
    for (let r = 0; r <= 8; r++) {
      if (foundAt !== -1 && r > foundAt + 1) break;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = cells.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const i of arr) {
          const d = fastDist(c, coords[i], cosLat);
          if (d < bestD) { bestD = d; best = i; if (foundAt === -1) foundAt = r; }
        }
      }
    }
    if (best === -1) coords.forEach((p, i) => { if (!adj[i].length) return; const d = fastDist(c, p, cosLat); if (d < bestD) { bestD = d; best = i; } });
    return { node: best, dist: bestD };
  }

  return { coords, adj, cosLat, nearestNode, size: coords.length };
}

/** Distance (m) from p to segment a-b, and the position t∈[0,1] of the closest point. */
export function projectOnSegment(p, a, b, cosLat) {
  const ax = a[0] * cosLat, ay = a[1], bx = b[0] * cosLat, by = b[1], px = p[0] * cosLat, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  const d = Math.hypot(px - qx, py - qy) * 111195; // degrees → metres
  return { d, t, point: [qx / cosLat, qy] };
}

/**
 * Attach every building to its nearest network node. Results are cached per
 * geometry object, so only moved/new buildings are recomputed after an edit.
 */
export function attachBuildings(graph, buildings, cache = new WeakMap()) {
  const out = new Map();
  for (const f of buildings) {
    let a = cache.get(f.geometry);
    if (!a) {
      const c = polygonCentroid(f.geometry.coordinates);
      const { node, dist } = graph.nearestNode(c);
      a = { node, offset: Math.max(10, dist), centroid: c };
      cache.set(f.geometry, a);
    }
    out.set(f.properties.id, a);
  }
  return out;
}
