// Procedural stand-in town, laid out in the spirit of a small New England village:
// a main street through a compact commercial core, a river crossing just north of
// downtown, and residential streets fanning out on a slightly rotated grid.
//
// This is used when no real OpenStreetMap extract has been fetched
// (see scripts/fetch-town.mjs). The output format is identical to the real data.

import { localToLonLat } from '../engine/geo.js';
import { USES } from './uses.js';

// Kennebunk, Maine — downtown (Main St at Summer St)
export const KENNEBUNK_CENTER = [-70.5452, 43.3838];

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateTown({ center = KENNEBUNK_CENTER, seed = 7, rotationDeg = 32 } = {}) {
  const rnd = mulberry32(seed);
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  // Grid coords (u along main street, v across it) -> local meters -> lon/lat
  const toLL = (u, v) => localToLonLat(center, u * cos - v * sin, u * sin + v * cos);

  const AVE_SPACING = 150;   // distance between streets parallel to Main St
  const CROSS_SPACING = 130; // distance between cross streets
  const AVES = [-4, -3, -2, -1, 0, 1, 2, 3, 4];      // v index (0 = Main St)
  const CROSSES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]; // u index (0 = Summer St)
  const RIVER_U = 3.5 * CROSS_SPACING; // river crosses the grid north of downtown
  const RIVER_HALF_W = 38;

  const features = [];
  let id = 1;
  const inRiver = (u) => Math.abs(u - RIVER_U) < RIVER_HALF_W + 20;

  // ---- River (Mousam-style band crossing the whole grid) ----
  {
    const ring = [];
    const vMin = -5 * AVE_SPACING, vMax = 5 * AVE_SPACING;
    const wave = (v) => 22 * Math.sin(v / 140) + 10 * Math.sin(v / 53);
    for (let v = vMin; v <= vMax; v += 30) ring.push(toLL(RIVER_U + RIVER_HALF_W + wave(v), v));
    for (let v = vMax; v >= vMin; v -= 30) ring.push(toLL(RIVER_U - RIVER_HALF_W + wave(v), v));
    ring.push(ring[0]);
    features.push({ type: 'Feature', properties: { kind: 'water', name: 'Mousam River' }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }

  // ---- Streets ----
  const aveNames = ['Brown St', 'Dane St', 'Storer St', 'Fletcher St', 'Main St', 'Water St', 'Park St', 'Grove St', 'High St'];
  const crossNames = ['Sea Rd', 'Bourne St', 'Green St', 'Winter St', 'Garden St', 'Summer St', 'Summer St', 'Elm St', 'Pleasant St', 'Mill Ln', 'Portland Rd', 'Cat Mousam Rd', 'Alewive Rd'];
  const uMin = CROSSES[0] * CROSS_SPACING, uMax = CROSSES[CROSSES.length - 1] * CROSS_SPACING;
  const vMin = AVES[0] * AVE_SPACING, vMax = AVES[AVES.length - 1] * AVE_SPACING;

  // Avenues run along u. Only Main St bridges the river; others stop at the bank.
  AVES.forEach((ai, k) => {
    const v = ai * AVE_SPACING;
    const highway = ai === 0 ? 'primary' : Math.abs(ai) === 2 ? 'secondary' : 'residential';
    const name = aveNames[k];
    // outer avenues are shorter so the town tapers
    const span = Math.abs(ai) >= 3 ? 4 : Math.abs(ai) === 2 ? 5 : 6;
    const u0 = -span * CROSS_SPACING, u1 = span * CROSS_SPACING;
    // vertices at every cross street so intersections share a node
    const us = CROSSES.map((ci) => ci * CROSS_SPACING).filter((u) => u >= u0 && u <= u1 && !inRiver(u));
    const line = (a, b) => us.filter((u) => u >= a && u <= b).map((u) => toLL(u, v));
    if (ai === 0) {
      features.push(street(id++, name, highway, line(u0, u1)));
    } else {
      // south bank segment (ends at the river bank)
      const south = [...line(u0, RIVER_U), toLL(RIVER_U - RIVER_HALF_W - 30, v)];
      features.push(street(id++, name, highway, south));
      // north bank segment, only for the inner avenues
      if (Math.abs(ai) <= 2 && u1 > RIVER_U) features.push(street(id++, name, highway, [toLL(RIVER_U + RIVER_HALF_W + 30, v), ...line(RIVER_U, u1)]));
    }
  });
  // Cross streets run along v.
  CROSSES.forEach((ci, k) => {
    const u = ci * CROSS_SPACING;
    if (inRiver(u)) return;
    const highway = ci === 0 ? 'secondary' : 'residential';
    const name = crossNames[k];
    const span = Math.abs(ci) >= 5 ? 2 : Math.abs(ci) >= 4 ? 3 : 4;
    const vs = [];
    for (let v = -span * AVE_SPACING; v <= span * AVE_SPACING; v += AVE_SPACING) vs.push(v);
    // Skip a few random outer segments so blocks are irregular (still connected via avenues).
    const parts = [];
    let cur = [toLL(u, vs[0])];
    for (let i = 1; i < vs.length; i++) {
      const outer = Math.abs(vs[i]) >= 3 * AVE_SPACING || Math.abs(ci) >= 4;
      if (outer && rnd() < 0.28) {
        if (cur.length > 1) parts.push(cur);
        cur = [toLL(u, vs[i])];
      } else cur.push(toLL(u, vs[i]));
    }
    if (cur.length > 1) parts.push(cur);
    parts.forEach((p) => features.push(street(id++, name, highway, p)));
  });
  // A riverside path along the south bank (footway)
  features.push(street(id++, 'Riverwalk', 'footway', [
    toLL(RIVER_U - RIVER_HALF_W - 30, -2 * AVE_SPACING), toLL(RIVER_U - RIVER_HALF_W - 30, 2 * AVE_SPACING),
  ]));

  // ---- Buildings ----
  // Helper: a rectangle in grid coords centered at (u, v) with size (w along u, d along v)
  const rect = (u, v, w, d) => {
    const ring = [toLL(u - w / 2, v - d / 2), toLL(u + w / 2, v - d / 2), toLL(u + w / 2, v + d / 2), toLL(u - w / 2, v + d / 2)];
    ring.push(ring[0]);
    return [ring];
  };
  const addBuilding = (use, u, v, w, d, name, levels) => {
    if (inRiver(u) || inRiver(u - w / 2) || inRiver(u + w / 2)) return;
    if (u < uMin - 40 || u > uMax + 40 || v < vMin - 40 || v > vMax + 40) return;
    const lv = levels ?? USES[use].defaultLevels;
    const f = {
      type: 'Feature',
      properties: { kind: 'building', id: `b${id++}`, use, levels: lv, name: name || null, footprintM2: Math.round(w * d), _g: { u, v, w, d } },
      geometry: { type: 'Polygon', coordinates: rect(u, v, w, d) },
    };
    features.push(f);
    occupied.push(f);
    return f;
  };
  const occupied = [];

  // Landmarks (roughly where a village like this keeps them)
  addBuilding('civic', -0.5 * CROSS_SPACING, 1.35 * AVE_SPACING, 28, 20, 'Town Hall', 2);
  addBuilding('library', 0.6 * CROSS_SPACING, -1.35 * AVE_SPACING, 24, 18, 'Free Library', 1);
  addBuilding('church', -1.4 * CROSS_SPACING, 0.45 * AVE_SPACING, 18, 30, 'First Parish', 1);
  addBuilding('church', 1.6 * CROSS_SPACING, -0.45 * AVE_SPACING, 16, 26, 'Christ Church', 1);
  addBuilding('transit', 0.15 * CROSS_SPACING, 0.12 * AVE_SPACING, 6, 4, 'Main St bus stop', 0);
  addBuilding('pharmacy', 0.9 * CROSS_SPACING, 0.4 * AVE_SPACING, 22, 16, 'Village Pharmacy', 1);
  addBuilding('bank', -0.9 * CROSS_SPACING, -0.4 * AVE_SPACING, 20, 16, 'Savings Bank', 2);
  addBuilding('school', -2.5 * CROSS_SPACING, -2.5 * AVE_SPACING, 70, 45, 'Elementary School', 2);
  addBuilding('school', 2.5 * CROSS_SPACING, 2.55 * AVE_SPACING, 80, 50, 'High School', 2);
  addBuilding('park', -1.5 * CROSS_SPACING, 2.5 * AVE_SPACING, 110, 100, 'Village Green', 0);
  addBuilding('park', 2.45 * CROSS_SPACING, -1.5 * AVE_SPACING, 90, 90, 'Rotary Park', 0);
  addBuilding('park', 2.55 * CROSS_SPACING, 0.5 * AVE_SPACING, 60, 90, 'Riverside Park', 0);
  addBuilding('grocery', 5.0 * CROSS_SPACING, 0.55 * AVE_SPACING, 70, 45, 'Supermarket (Portland Rd)', 1);
  addBuilding('parking', 5.0 * CROSS_SPACING, -0.5 * AVE_SPACING, 80, 60, 'Supermarket lot', 0);
  addBuilding('healthcare', 5.5 * CROSS_SPACING, 1.5 * AVE_SPACING, 40, 30, 'Medical Center', 2);
  addBuilding('gym', -3.5 * CROSS_SPACING, 1.5 * AVE_SPACING, 40, 30, 'Rec Center', 1);
  addBuilding('hotel', 0.5 * CROSS_SPACING, 1.5 * AVE_SPACING, 26, 20, 'Village Inn', 3);
  addBuilding('parking', -0.5 * CROSS_SPACING, -0.55 * AVE_SPACING, 40, 30, 'Municipal lot', 0);
  addBuilding('industrial', -5.3 * CROSS_SPACING, -1.5 * AVE_SPACING, 60, 40, null, 1);
  addBuilding('industrial', -5.3 * CROSS_SPACING, -0.5 * AVE_SPACING, 50, 35, null, 1);
  addBuilding('office', -5.0 * CROSS_SPACING, 0.5 * AVE_SPACING, 40, 30, null, 2);

  const overlaps = (u, v, w, d) => {
    // cheap AABB overlap check in grid space
    for (const f of occupied) {
      const p = f.properties._g;
      if (Math.abs(p.u - u) < (p.w + w) / 2 + 6 && Math.abs(p.v - v) < (p.d + d) / 2 + 6) return true;
    }
    return false;
  };

  const coreUses = ['retail', 'retail', 'restaurant', 'cafe', 'mixed', 'mixed', 'mixed', 'office', 'retail', 'restaurant'];
  const place = (use, u, v, w, d, levels, name) => {
    if (overlaps(u, v, w, d)) return false;
    return !!addBuilding(use, u, v, w, d, name, levels);
  };

  // Frontage lots along every avenue (both sides)
  AVES.forEach((ai) => {
    const v = ai * AVE_SPACING;
    const span = Math.abs(ai) >= 3 ? 4 : Math.abs(ai) === 2 ? 5 : 6;
    for (const side of [-1, 1]) {
      let u = -span * CROSS_SPACING + 25;
      while (u < span * CROSS_SPACING - 20) {
        const distCore = Math.hypot(u / 1.15, v); // core is stretched along Main St
        const isCore = ai === 0 && Math.abs(u) < 2.2 * CROSS_SPACING || (Math.abs(ai) === 1 && Math.abs(u) < 1.2 * CROSS_SPACING);
        if (isCore) {
          const w = 12 + Math.floor(rnd() * 10);
          const d = 16 + Math.floor(rnd() * 8);
          const use = coreUses[Math.floor(rnd() * coreUses.length)];
          place(use, u + w / 2, v + side * (12 + d / 2), w, d, use === 'mixed' ? 2 + Math.floor(rnd() * 2) : USES[use].defaultLevels);
          u += w + 3 + Math.floor(rnd() * 4);
        } else if (distCore < 950) {
          const lot = 26 + Math.floor(rnd() * 12);
          const w = 9 + Math.floor(rnd() * 5), d = 10 + Math.floor(rnd() * 5);
          const r = rnd();
          const use = distCore < 380 && r < 0.18 ? 'apartments' : r < 0.02 ? 'vacant' : 'residential';
          const setback = 14 + Math.floor(rnd() * 8);
          if (rnd() > 0.08) place(use, u + lot / 2, v + side * (setback + d / 2), use === 'apartments' ? w + 8 : w, use === 'apartments' ? d + 6 : d, use === 'apartments' ? 3 : 1 + Math.floor(rnd() * 2));
          u += lot;
        } else {
          const lot = 40 + Math.floor(rnd() * 20);
          const w = 9 + Math.floor(rnd() * 5), d = 10 + Math.floor(rnd() * 5);
          if (rnd() > 0.25) place('residential', u + lot / 2, v + side * (18 + d / 2), w, d, 1 + Math.floor(rnd() * 2));
          u += lot;
        }
      }
    }
  });
  // Lots along cross streets, skipping frontage already taken near avenues
  CROSSES.forEach((ci) => {
    const u = ci * CROSS_SPACING;
    if (inRiver(u)) return;
    const span = Math.abs(ci) >= 5 ? 2 : Math.abs(ci) >= 4 ? 3 : 4;
    for (const side of [-1, 1]) {
      let v = -span * AVE_SPACING + 40;
      while (v < span * AVE_SPACING - 35) {
        const distCore = Math.hypot(u / 1.15, v);
        const lot = 28 + Math.floor(rnd() * 12);
        const w = 9 + Math.floor(rnd() * 5), d = 10 + Math.floor(rnd() * 5);
        if (distCore < 1000 && rnd() > 0.1) {
          const use = distCore < 300 && rnd() < 0.25 ? 'mixed' : 'residential';
          place(use, u + side * (14 + w / 2), v + lot / 2, use === 'mixed' ? w + 4 : w, d, use === 'mixed' ? 2 : 1 + Math.floor(rnd() * 2));
        }
        v += lot;
      }
    }
  });

  // strip helper props
  for (const f of features) delete f.properties._g;

  return {
    type: 'FeatureCollection',
    properties: { name: 'Kennebunk, ME (stylized stand-in)', center, source: 'generated', note: 'Run `npm run fetch-town -- "Kennebunk, Maine"` to replace with real OpenStreetMap data.' },
    features,
  };
}

function street(id, name, highway, coords) {
  return { type: 'Feature', properties: { kind: 'street', id: `s${id}`, name, highway }, geometry: { type: 'LineString', coordinates: coords } };
}
