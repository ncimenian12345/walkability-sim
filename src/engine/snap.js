// Snapping for the editor: find the closest street vertex or point on a street
// segment to the cursor, plus the street's bearing (used to align dropped buildings).

import { projectOnSegment } from './graph.js';

const CELL = 0.001; // ~80–110 m grid

export function makeSnapper(streets) {
  const segs = [];
  const grid = new Map();
  const lat0 = streets[0]?.geometry.coordinates[0]?.[1] ?? 43;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  for (const f of streets) {
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) {
      const s = { a: c[i - 1], b: c[i], id: f.properties.id };
      const idx = segs.push(s) - 1;
      const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELL), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
      const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELL), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(idx);
      }
    }
  }

  /**
   * @param p      [lon, lat]
   * @param tolM   snap tolerance in metres
   * @returns {point, snapped, kind: 'vertex'|'segment'|null, streetId, bearing, dist}
   */
  return function snap(p, tolM = 12) {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    const r = Math.max(1, Math.ceil(tolM / 80));
    let best = null;
    const seen = new Set();
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const arr = grid.get(`${cx + dx},${cy + dy}`);
      if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = segs[i];
        const pr = projectOnSegment(p, s.a, s.b, cosLat);
        if (!best || pr.d < best.d) best = { ...pr, s };
      }
    }
    if (!best) return { point: p, snapped: false, kind: null, bearing: 0, dist: Infinity };
    const { s } = best;
    const bearing = (Math.atan2((s.b[0] - s.a[0]) * cosLat, s.b[1] - s.a[1]) * 180) / Math.PI;
    if (best.d > tolM) return { point: p, snapped: false, kind: null, bearing, dist: best.d, streetId: s.id };
    // prefer the vertex if it is close
    const vx = best.t < 0.5 ? s.a : s.b;
    const vd = Math.hypot((vx[0] - p[0]) * cosLat, vx[1] - p[1]) * 111195;
    if (vd <= tolM * 0.8) return { point: vx, snapped: true, kind: 'vertex', streetId: s.id, bearing, dist: vd };
    return { point: [+best.point[0].toFixed(7), +best.point[1].toFixed(7)], snapped: true, kind: 'segment', streetId: s.id, bearing, dist: best.d };
  };
}
