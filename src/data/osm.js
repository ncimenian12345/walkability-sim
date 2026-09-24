// OpenStreetMap -> simulator town conversion. Shared by the in-browser loader
// (Sidebar → "Load real buildings for this view") and scripts/fetch-town.mjs.

import { fetchStructures, mergeStructures } from './structures.js';

// Bump when the conversion changes so cached towns are re-downloaded.
export const DATA_VERSION = 2;

export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// ---- OSM tags -> simulator use ------------------------------------------------
export function useFromTags(t = {}) {
  const shop = t.shop, am = t.amenity, b = t.building, leisure = t.leisure, office = t.office;
  if (['supermarket', 'greengrocer', 'convenience', 'butcher', 'bakery', 'deli', 'grocery'].includes(shop)) return 'grocery';
  if (am === 'pharmacy' || shop === 'chemist') return 'pharmacy';
  if (am === 'cafe' || shop === 'coffee') return 'cafe';
  if (['restaurant', 'fast_food', 'bar', 'pub', 'ice_cream', 'food_court'].includes(am)) return 'restaurant';
  if (['school', 'kindergarten', 'college', 'university'].includes(am) || b === 'school') return 'school';
  if (am === 'library') return 'library';
  if (am === 'bank' || am === 'atm') return 'bank';
  if (['doctors', 'clinic', 'hospital', 'dentist'].includes(am) || b === 'hospital') return 'healthcare';
  if (['townhall', 'post_office', 'police', 'fire_station', 'community_centre', 'courthouse'].includes(am) || b === 'civic' || b === 'public') return 'civic';
  if (am === 'place_of_worship' || b === 'church' || b === 'chapel') return 'church';
  if (['fitness_centre', 'sports_centre', 'swimming_pool'].includes(leisure)) return 'gym';
  if (['park', 'playground', 'garden', 'pitch', 'dog_park', 'nature_reserve'].includes(leisure)) return 'park';
  if (am === 'parking' || ['parking', 'garage', 'garages', 'carport'].includes(b)) return 'parking';
  if (['hotel', 'motel', 'guest_house'].includes(t.tourism) || b === 'hotel') return 'hotel';
  if (b === 'industrial' || b === 'warehouse' || b === 'manufacture') return 'industrial';
  if (office || b === 'office' || b === 'commercial') return 'office';
  if (shop || b === 'retail') return 'retail';
  if (b === 'apartments' || b === 'dormitory') return 'apartments';
  if (['house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'cabin', 'yes', 'farm'].includes(b)) return 'residential';
  if (['shed', 'roof', 'barn', 'hut', 'greenhouse', 'service', 'boathouse', 'stable'].includes(b)) return null; // outbuildings
  return b ? 'residential' : null;
}

const NON_ROADS = new Set(['motorway', 'motorway_link', 'trunk_link', 'proposed', 'construction', 'raceway', 'bus_guideway', 'abandoned', 'platform', 'elevator', 'corridor']);
const DEFAULT_LEVELS = { residential: 2, apartments: 3, mixed: 3, grocery: 1, cafe: 1, restaurant: 1, retail: 1, pharmacy: 1, healthcare: 2, school: 2, library: 1, park: 0, gym: 1, bank: 1, transit: 0, office: 2, civic: 2, church: 1, hotel: 3, industrial: 1, parking: 0, vacant: 1 };

/** Overpass QL for everything the simulator needs inside `filter`, e.g. "(43.37,-70.56,43.40,-70.53)". */
export function overpassQuery(filter, areaDef = '') {
  return `[out:json][timeout:180];${areaDef}
(
  way["building"]${filter};
  way["highway"]${filter};
  node["amenity"]${filter}; node["shop"]${filter}; node["leisure"]${filter}; node["tourism"]${filter}; node["office"]${filter};
  node["highway"="bus_stop"]${filter}; node["public_transport"="platform"]${filter};
  way["leisure"~"^(park|playground|garden|pitch|dog_park)$"]${filter};
  way["amenity"="parking"]${filter};
  way["natural"="water"]${filter}; way["waterway"="riverbank"]${filter};
);
out geom;`;
}

export async function runOverpass(query, { headers = {}, signal } = {}) {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: 'data=' + encodeURIComponent(query), signal });
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}

export async function geocode(q, { headers = {} } = {}) {
  const r = await fetch(`${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, { headers });
  if (!r.ok) throw new Error(`Place search failed (${r.status})`);
  const [hit] = await r.json();
  if (!hit) throw new Error(`No place called "${q}"`);
  return { name: hit.display_name, center: [Number(hit.lon), Number(hit.lat)], bbox: hit.boundingbox?.map(Number), osmType: hit.osm_type, osmId: hit.osm_id };
}

// ---- geometry helpers ----------------------------------------------------------
function ringArea(ring) {
  const R = 6371008.8, D2R = Math.PI / 180;
  const kx = R * D2R * Math.cos(ring[0][1] * D2R), ky = R * D2R;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  return Math.abs(s) / 2;
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const centroid = (ring) => { let x = 0, y = 0; const n = ring.length - 1; for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; } return [x / n, y / n]; };

/** Convert an Overpass JSON response into a simulator town FeatureCollection. */
export function convertOverpass(data, { name, center, bbox }) {
  const streets = [], water = [], buildings = [], pois = [];

  for (const el of data.elements) {
    const t = el.tags || {};
    if (el.type === 'node') {
      const use = t.highway === 'bus_stop' || t.public_transport === 'platform' ? 'transit' : useFromTags(t);
      if (use) pois.push({ use, name: t.name || null, pt: [el.lon, el.lat] });
      continue;
    }
    if (el.type !== 'way' || !el.geometry) continue;
    const coords = el.geometry.map((p) => [p.lon, p.lat]);
    const closed = coords.length > 3 && coords[0][0] === coords.at(-1)[0] && coords[0][1] === coords.at(-1)[1];

    if (t.highway && !NON_ROADS.has(t.highway) && !closed) {
      streets.push({ type: 'Feature', properties: { kind: 'street', id: `s${el.id}`, name: t.name || null, highway: t.highway, sidewalk: t.sidewalk || null }, geometry: { type: 'LineString', coordinates: coords } });
      continue;
    }
    if (t.highway && closed && !NON_ROADS.has(t.highway) && t.area !== 'yes') {
      // closed loops (roundabouts, looped footpaths) are still walkable lines
      streets.push({ type: 'Feature', properties: { kind: 'street', id: `s${el.id}`, name: t.name || null, highway: t.highway, sidewalk: t.sidewalk || null }, geometry: { type: 'LineString', coordinates: coords } });
      continue;
    }
    if (!closed) continue;
    if (t.natural === 'water' || t.waterway === 'riverbank') {
      water.push({ type: 'Feature', properties: { kind: 'water', name: t.name || null }, geometry: { type: 'Polygon', coordinates: [coords] } });
      continue;
    }
    const use = useFromTags(t);
    if (!use) continue;
    if (!t.building && !['park', 'parking'].includes(use)) continue; // school/church grounds etc: the building itself is mapped separately
    const area = ringArea(coords);
    if (t.building && area < 25) continue;
    const levels = Number(t['building:levels']) || (t.height ? Math.max(1, Math.round(Number.parseFloat(t.height) / 3.2)) : null);
    buildings.push({ type: 'Feature', properties: { kind: 'building', id: `b${el.id}`, use, levels, levelsTagged: !!levels, name: t.name || null, footprintM2: Math.round(area) }, geometry: { type: 'Polygon', coordinates: [coords] } });
  }

  // Businesses mapped as points: move their use onto the building they sit in
  const cosLat = Math.cos(((center?.[1] ?? 43) * Math.PI) / 180);
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * cosLat, (a[1] - b[1]) * 110540);
  const cents = buildings.map((b) => centroid(b.geometry.coordinates[0]));
  const nMapped = buildings.length; // point amenities appended below are not match targets
  let n = 0;
  for (const poi of pois) {
    let best = -1, bestD = Infinity;
    if (poi.use !== 'transit') {
      for (let i = 0; i < nMapped; i++) {
        const d = dist(poi.pt, cents[i]);
        if (d > 150) continue;
        if (pointInRing(poi.pt, buildings[i].geometry.coordinates[0])) { best = i; bestD = 0; break; }
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const p = best >= 0 ? buildings[best].properties : null;
    if (p && bestD <= 25 && ['residential', 'office', 'retail', 'mixed', 'apartments'].includes(p.use)) {
      // a shop inside a building tagged as flats -> mixed-use keeps both
      p.use = p.use === 'apartments' && ['retail', 'cafe', 'restaurant'].includes(poi.use) ? 'mixed' : poi.use;
      p.name = p.name || poi.name;
    } else if (!p || bestD > 25) {
      const d = 0.00004, [x, y] = poi.pt;
      buildings.push({ type: 'Feature', properties: { kind: 'building', id: `p${n++}_${Math.round(x * 1e5)}_${Math.round(y * 1e5)}`, use: poi.use, levels: 0, name: poi.name, footprintM2: 16, point: true }, geometry: { type: 'Polygon', coordinates: [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]] } });
    }
  }
  for (const b of buildings) if (b.properties.levels == null) b.properties.levels = DEFAULT_LEVELS[b.properties.use] ?? 1;

  return {
    type: 'FeatureCollection',
    properties: { name, center, bbox, source: 'openstreetmap', dataVersion: DATA_VERSION, key: `osm:${bbox ? bbox.map((v) => v.toFixed(4)).join(',') : name}`, fetchedAt: new Date().toISOString(), attribution: '© OpenStreetMap contributors (ODbL)' },
    features: [...water, ...streets, ...buildings],
  };
}

/**
 * Fetch a town for a bounding box [west, south, east, north]: streets, businesses and
 * named places from OpenStreetMap, building footprints from FEMA USA Structures
 * (falls back to OSM outlines alone outside the US or if that service is down).
 */
export async function fetchTownBBox([w, s, e, n], { name = 'Custom area', headers, signal, onProgress } = {}) {
  const osmP = runOverpass(overpassQuery(`(${s},${w},${n},${e})`), { headers, signal });
  const femaP = fetchStructures([w, s, e, n], { signal }).catch((err) => { onProgress?.(`Building footprints unavailable (${err.message}); using OpenStreetMap outlines only.`); return []; });
  const [data, fema] = await Promise.all([osmP, femaP]);
  const town = convertOverpass(data, { name, center: [(w + e) / 2, (s + n) / 2], bbox: [w, s, e, n] });
  return fema.length ? mergeStructures(town, fema) : town;
}

// Downtown Kennebunk, ME, roughly 2.8 km × 2.7 km
export const KENNEBUNK_BBOX = [-70.5625, 43.3715, -70.5275, 43.3960];
