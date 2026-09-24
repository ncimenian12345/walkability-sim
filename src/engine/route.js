// Point-to-point walking routes over the pedestrian graph, for the route planner
// and the street-level walk mode. Routes use the same comfort-weighted costs as
// the walkability metrics, so a new footpath or a removed sidewalk changes them
// the same way it changes the 15-minute numbers.

import { fastDist } from './geo.js';
import { WALK_SPEED_M_PER_MIN } from '../data/uses.js';

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      k[0] = lastK; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return [topK, topV];
  }
}

/**
 * Cheapest path between two nodes, or between two sets of candidate entry/exit
 * nodes (Dijkstra with early exit). Candidates are [node, extraCost] pairs — the
 * cost of getting from the real start point onto that node, and from the exit
 * node to the real destination.
 *
 * @param {number|Array<[number, number]>} from
 * @param {number|Array<[number, number]>} to
 * @returns {{nodes:number[], cost:number, meters:number, fids:number[], from:number, to:number}|null}
 *   `fids[i]` is the street index of the edge from nodes[i] to nodes[i+1]; `cost`
 *   and `meters` cover only the edges between `from` and `to`.
 */
export function shortestPath(graph, from, to) {
  const sources = typeof from === 'number' ? [[from, 0]] : from;
  const targets = typeof to === 'number' ? [[to, 0]] : to;
  if (!sources.length || !targets.length || sources.some(([n]) => n < 0) || targets.some(([n]) => n < 0)) return null;
  const n = graph.size;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1); // index into adj[prev] of the edge used
  const srcOf = new Int32Array(n).fill(-1);
  const targetExtra = new Map(targets.map(([t, x]) => [t, x]));
  const heap = new MinHeap();
  for (const [s, d0] of sources) if (d0 < dist[s]) { dist[s] = d0; srcOf[s] = s; heap.push(d0, s); }
  const adj = graph.adj;
  let best = null, bestTotal = Infinity;
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (d >= bestTotal) break; // nothing cheaper can still turn up
    if (targetExtra.has(u)) {
      const total = d + targetExtra.get(u);
      if (total < bestTotal) { bestTotal = total; best = u; }
    }
    const edges = adj[u];
    for (let i = 0; i < edges.length; i++) {
      const [v, w] = edges[i];
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevEdge[v] = i; srcOf[v] = srcOf[u]; heap.push(nd, v); }
    }
  }
  if (best === null) return null;
  const nodes = [], fids = [];
  let meters = 0, cost = 0;
  for (let u = best; prev[u] !== -1; u = prev[u]) {
    nodes.push(u);
    const e = adj[prev[u]][prevEdge[u]];
    fids.push(e[2]);
    meters += e[3];
    cost += e[1];
  }
  const start = nodes.length ? prev[nodes[nodes.length - 1]] : best;
  nodes.push(start);
  nodes.reverse(); fids.reverse();
  return { nodes, cost, meters, fids, from: start, to: best };
}

/**
 * Where a point joins the walking network. If it sits on a street (within
 * `tolM`), it can enter at either end of that street segment; otherwise it walks
 * straight to the nearest node.
 * @returns {{point:number[], entries:Array<[node, metres, fid]>, stub:number, segment:string|null}}
 *   `point` is the spot on the street; `stub` the straight-line metres from p to it;
 *   `segment` identifies the street segment it sits on (null when off-street).
 */
export function attachPoint(graph, streets, p, snap, tolM = 30) {
  const s = snap ? snap(p, tolM) : null;
  if (s?.snapped) {
    const fid = streets.findIndex((f) => f.properties.id === s.streetId);
    const f = streets[fid];
    if (f) {
      const line = f.geometry.coordinates;
      for (let i = 1; i < line.length; i++) {
        const pr = projectOnSegment(s.point, line[i - 1], line[i], graph.cosLat);
        if (pr.d > 0.5) continue;
        const a = graph.nearestNode(line[i - 1]), b = graph.nearestNode(line[i]);
        const entries = [];
        if (a.node >= 0 && a.dist < 1) entries.push([a.node, fastDist(s.point, line[i - 1], graph.cosLat), fid]);
        if (b.node >= 0 && b.dist < 1) entries.push([b.node, fastDist(s.point, line[i], graph.cosLat), fid]);
        // a drawn footpath may have been spliced into this segment: its junction node is
        // not a vertex of the street feature, so offer the nearest graph node as well
        const nn = graph.nearestNode(s.point);
        if (nn.node >= 0 && !entries.some(([n]) => n === nn.node)) entries.push([nn.node, nn.dist, fid]);
        if (entries.length) return { point: s.point, entries, stub: fastDist(p, s.point, graph.cosLat), segment: `${fid}:${Math.min(a.node, b.node)}-${Math.max(a.node, b.node)}` };
      }
    }
  }
  const nn = graph.nearestNode(p);
  return { point: p, entries: nn.node >= 0 ? [[nn.node, nn.dist, null]] : [], stub: 0, segment: null };
}

function projectOnSegment(p, a, b, cosLat) {
  const ax = a[0] * cosLat, ay = a[1], bx = b[0] * cosLat, by = b[1], px = p[0] * cosLat, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { d: Math.hypot(px - qx, py - qy) * 111195, t };
}

/**
 * Plan a walking route through `waypoints` ([lon, lat] each). Every waypoint is
 * attached to its nearest network node with a short straight stub, like buildings are.
 *
 * @returns null when fewer than two waypoints; otherwise
 *   { coords, meters, cost, minutes, walkMinutes, cum, streets, legs, unreachable }
 *   coords      the polyline to draw
 *   meters      real length (m); minutes = comfort-weighted time; walkMinutes = meters / speed
 *   cum         cumulative distance (m) at every vertex of coords — used to animate the walk
 *   streets     [{id, name, highway, sidewalk, meters}] in walking order (consecutive same-street edges merged)
 *   legs        per pair of waypoints: {meters, cost, ok}
 */
export function planRoute(graph, streets, waypoints, snap = null) {
  if (!graph || waypoints.length < 2) return null;
  const coords = [];
  const segFid = []; // segFid[i]: street index of segment coords[i]→coords[i+1]; null = stub, 'gap' = unreachable
  const legs = [];
  let unreachable = false;
  const push = (c, fid) => {
    const last = coords[coords.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) return; // zero-length segment: drop it
    if (last) segFid.push(fid);
    coords.push(c);
  };
  const attached = waypoints.map((p) => attachPoint(graph, streets, p, snap));
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const A = attached[i - 1], B = attached[i];
    const sameSegment = A.segment !== null && A.segment === B.segment;
    if (sameSegment) {
      // both stops on one stretch of street: walk straight along it
      const along = fastDist(A.point, B.point, graph.cosLat);
      const fid = A.entries[0][2];
      push(a, null); push(A.point, null); push(B.point, fid); push(b, null);
      const meters = A.stub + along + B.stub;
      legs.push({ meters, cost: meters, ok: true });
      continue;
    }
    const path = shortestPath(graph, A.entries.map(([n, d]) => [n, d]), B.entries.map(([n, d]) => [n, d]));
    if (!path) {
      unreachable = true;
      legs.push({ meters: 0, cost: 0, ok: false });
      push(a, null); push(b, 'gap');
      continue;
    }
    const inA = A.entries.find(([n]) => n === path.from), inB = B.entries.find(([n]) => n === path.to);
    push(a, null);
    push(A.point, null);
    path.nodes.forEach((node, k) => push(graph.coords[node], k === 0 ? inA[2] : path.fids[k - 1]));
    push(B.point, inB[2]);
    push(b, null);
    const meters = path.meters + A.stub + inA[1] + inB[1] + B.stub;
    legs.push({ meters, cost: path.cost + A.stub + inA[1] + inB[1] + B.stub, ok: true });
  }

  // Cumulative distance along the drawn line (straight-line between drawn vertices).
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + fastDist(coords[i - 1], coords[i], graph.cosLat));
  const meters = legs.reduce((s, l) => s + l.meters, 0);
  const cost = legs.reduce((s, l) => s + l.cost, 0);

  // Street-by-street summary, consecutive edges on the same street merged.
  const out = [];
  for (let i = 0; i < segFid.length; i++) {
    const fid = segFid[i];
    if (fid === 'gap') continue;
    const f = fid != null ? streets[fid] : null;
    const id = f ? f.properties.id : null;
    const len = cum[i + 1] - cum[i];
    const last = out[out.length - 1];
    if (last && last.id === id) last.meters += len;
    else out.push({ id, name: f ? f.properties.name || null : null, highway: f ? f.properties.highway : null, sidewalk: f ? f.properties.sidewalk || null : null, added: !!f?.properties.added, meters: len });
  }
  const streetsUsed = out.filter((s) => s.meters >= 1 && (s.id !== null || s.meters > 5));

  return {
    coords, cum, meters, cost, legs, unreachable,
    minutes: cost / WALK_SPEED_M_PER_MIN,
    walkMinutes: meters / WALK_SPEED_M_PER_MIN,
    length: cum[cum.length - 1],
    streets: streetsUsed,
  };
}

/** Position and heading (degrees clockwise from north) at distance `d` along a route. */
export function pointAlong(route, d) {
  const { coords, cum } = route;
  const n = coords.length;
  if (n === 0) return null;
  if (n === 1 || d <= 0) return { pos: coords[0], bearing: n > 1 ? bearingBetween(coords[0], coords[1]) : 0, i: 0 };
  const total = cum[n - 1];
  if (d >= total) return { pos: coords[n - 1], bearing: bearingBetween(coords[n - 2], coords[n - 1]), i: n - 2 };
  // binary search for the segment containing d
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const a = coords[lo], b = coords[lo + 1];
  const seg = cum[lo + 1] - cum[lo];
  const t = seg > 0 ? (d - cum[lo]) / seg : 0;
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearingBetween(a, b), i: lo };
}

export function bearingBetween(a, b) {
  const cosLat = Math.cos((a[1] * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * cosLat, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

/** Move `m` metres from `p` along `bearingDeg`. */
export function offsetPoint(p, m, bearingDeg) {
  const R = 6371008.8, D2R = Math.PI / 180;
  const b = bearingDeg * D2R;
  const dLat = (m * Math.cos(b)) / (R * D2R);
  const dLon = (m * Math.sin(b)) / (R * D2R * Math.cos(p[1] * D2R));
  return [p[0] + dLon, p[1] + dLat];
}
