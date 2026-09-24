// FEMA "USA Structures" building footprints (every structure > 40 m² in the US,
// traced from imagery, with occupancy class, height and a population estimate).
// OpenStreetMap is often sparse for building outlines in small towns, so the
// loader uses these footprints and then lays OSM names/business types on top.
// Public ArcGIS service, CORS-enabled, no key.

const SERVICE = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query';
const PAGE = 2000;
const MAX_FEATURES = 20000;

const PRIM_OCC_USE = {
  'Single Family Dwelling': 'residential',
  'Manufactured Home': 'residential',
  'Multi - Family Dwelling': 'apartments',
  'Nursing Home': 'apartments',
  'Temporary Lodging': 'hotel',
  'Institutional Dormitory': 'apartments',
  'Retail Trade': 'retail',
  'Wholesale Trade': 'industrial',
  'Personal and Repair Services': 'retail',
  'Professional/Technical Services': 'office',
  'Banks': 'bank',
  'Hospital': 'healthcare',
  'Medical Office/Clinic': 'healthcare',
  'Entertainment and Recreation': 'gym',
  'Theaters': 'civic',
  'Parking': 'parking',
  'Religious': 'church',
  'Community Center': 'civic',
  'General Services': 'civic',
  'Emergency Response': 'civic',
  'Pre-K - 12 Schools': 'school',
  'Colleges/Universities': 'school',
  'Heavy': 'industrial',
  'Light': 'industrial',
  'Food/Drugs/Chemicals': 'industrial',
  'Metals/Minerals Processing': 'industrial',
  'High Technology': 'industrial',
  'Construction': 'industrial',
  'Agriculture': 'industrial',
};
const OCC_CLS_USE = { Residential: 'residential', Commercial: 'retail', Industrial: 'industrial', Government: 'civic', Education: 'school', Assembly: 'civic', Agriculture: 'industrial' };

export function femaUse(p) {
  if (p.OUTBLDG === 'Y' || p.OUTBLDG === 'Yes') return null;
  const u = PRIM_OCC_USE[p.PRIM_OCC] || OCC_CLS_USE[p.OCC_CLS];
  if (u) return u;
  // Unclassified: mostly garages and barns. Keep big ones as vacant (a candidate site).
  return (p.SQMETERS ?? 0) >= 80 ? 'vacant' : null;
}

/** Fetch raw FEMA features (GeoJSON) inside [w, s, e, n], following pagination. */
export async function fetchStructures([w, s, e, n], { signal } = {}) {
  const out = [];
  for (let offset = 0; offset < MAX_FEATURES; offset += PAGE) {
    const q = new URLSearchParams({
      where: '1=1', geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'BUILD_ID,OCC_CLS,PRIM_OCC,OUTBLDG,HEIGHT,SQMETERS,POP_MEDIAN',
      outSR: '4326', f: 'geojson', geometryPrecision: '7', resultOffset: String(offset), resultRecordCount: String(PAGE), orderByFields: 'OBJECTID',
    });
    const r = await fetch(`${SERVICE}?${q}`, { signal });
    if (!r.ok) throw new Error(`USA Structures answered ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'USA Structures error');
    out.push(...(j.features || []));
    const more = j.exceededTransferLimit || j.properties?.exceededTransferLimit;
    if (!more || !j.features?.length) break;
  }
  return out;
}

// ---- merge ------------------------------------------------------------------
const centroid = (ring) => { let x = 0, y = 0; const k = ring.length - 1 || 1; for (let i = 0; i < k; i++) { x += ring[i][0]; y += ring[i][1]; } return [x / k, y / k]; };
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const GENERIC = new Set(['residential', 'apartments', 'office', 'retail', 'vacant', 'mixed', 'civic']);
const DEFAULT_LEVELS = { residential: 2, apartments: 3, retail: 1, office: 2, civic: 2, school: 2, church: 1, hotel: 3, industrial: 1, healthcare: 2, bank: 1, gym: 1, parking: 1, vacant: 1 };

/**
 * Replace the OSM town's building outlines with FEMA footprints where they exist,
 * carrying OSM names and specific uses (café, pharmacy…) across.
 */
export function mergeStructures(town, femaFeatures) {
  const lat0 = town.properties.center?.[1] ?? 43;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * cosLat, (a[1] - b[1]) * 110540);

  // FEMA → simulator buildings
  const fema = [];
  for (const f of femaFeatures) {
    if (f.geometry?.type !== 'Polygon') continue;
    const use = femaUse(f.properties);
    if (!use) continue;
    const p = f.properties;
    const levels = p.HEIGHT ? Math.max(1, Math.round(p.HEIGHT / 3.3)) : DEFAULT_LEVELS[use] ?? 1;
    fema.push({
      type: 'Feature',
      properties: { kind: 'building', id: `f${p.BUILD_ID}`, use, levels, name: null, footprintM2: Math.round(p.SQMETERS || 0), pop: p.POP_MEDIAN ?? null, origUse: use, origLevels: levels },
      geometry: { type: 'Polygon', coordinates: [f.geometry.coordinates[0]] },
    });
  }
  if (!fema.length) return town;

  // grid index of FEMA centroids
  const CELL = 0.0008;
  const cents = fema.map((f) => centroid(f.geometry.coordinates[0]));
  const grid = new Map();
  cents.forEach((c, i) => { const k = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const near = (c, r = 1) => { const x = Math.floor(c[0] / CELL), y = Math.floor(c[1] / CELL), out = []; for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push(...(grid.get(`${x + dx},${y + dy}`) || [])); return out; };

  const osmBuildings = town.features.filter((f) => f.properties.kind === 'building');
  const kept = [];
  const claimed = new Set();
  for (const b of osmBuildings) {
    const p = b.properties;
    const ring = b.geometry.coordinates[0];
    const c = centroid(ring);
    let match = -1;
    if (p.point) {
      // business mapped as a point: the FEMA building it sits in, or the nearest within 20 m
      let best = 20;
      for (const i of near(c)) {
        if (pointInRing(c, fema[i].geometry.coordinates[0])) { match = i; break; }
        const d = distM(c, cents[i]);
        if (d < best) { best = d; match = i; }
      }
    } else {
      // outline: FEMA building whose centroid is inside it (largest), or which contains its centroid
      let bestArea = -1;
      for (const i of near(c, 2)) {
        if (pointInRing(cents[i], ring) && fema[i].properties.footprintM2 > bestArea) { bestArea = fema[i].properties.footprintM2; match = i; }
      }
      if (match < 0) for (const i of near(c)) if (pointInRing(c, fema[i].geometry.coordinates[0])) { match = i; break; }
    }

    const isLand = ['park', 'parking'].includes(p.use) && !p.point && !(b.properties.levels > 0);
    if (isLand || p.use === 'transit') { kept.push(b); continue; } // open land and bus stops are not buildings

    if (match >= 0 && (!claimed.has(match) || p.point)) {
      const fp = fema[match].properties;
      const specific = !GENERIC.has(p.use) || (p.point && p.use !== 'transit');
      if (specific || (p.use !== 'residential' && GENERIC.has(fp.use) && fp.use === 'vacant')) fp.use = fp.origUse = p.use === 'retail' && fp.use === 'apartments' ? 'mixed' : p.use;
      if (p.name && !fp.name) fp.name = p.name;
      if (p.levelsTagged) fp.levels = fp.origLevels = p.levels;
      claimed.add(match);
      continue; // FEMA footprint replaces it
    }
    kept.push(b); // not in FEMA (small, new, or a point amenity like a bus stop)
  }

  const features = [...town.features.filter((f) => f.properties.kind !== 'building'), ...kept, ...fema];
  return {
    ...town,
    properties: { ...town.properties, footprints: 'FEMA USA Structures', attribution: `${town.properties.attribution}; building footprints: FEMA USA Structures` },
    features,
  };
}
