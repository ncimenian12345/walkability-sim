// Small geodesy helpers. All distances in meters.

const R = 6371008.8;
const D2R = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const la1 = a[1] * D2R;
  const la2 = b[1] * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Fast equirectangular distance — good enough at town scale, ~10x faster than haversine. */
export function fastDist(a, b, cosLat) {
  const dx = (b[0] - a[0]) * D2R * cosLat * R;
  const dy = (b[1] - a[1]) * D2R * R;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Centroid of the outer ring of a polygon (simple vertex average is fine for small footprints). */
export function polygonCentroid(coords) {
  const ring = coords[0];
  let x = 0, y = 0;
  const n = ring.length - 1 || 1; // last vertex repeats first
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

/** Planar area in m² of a lon/lat polygon ring (shoelace on a local projection). */
export function polygonAreaM2(coords) {
  const ring = coords[0];
  const lat0 = ring[0][1] * D2R;
  const kx = R * D2R * Math.cos(lat0);
  const ky = R * D2R;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = [ring[i][0] * kx, ring[i][1] * ky];
    const [x2, y2] = [ring[i + 1][0] * kx, ring[i + 1][1] * ky];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Convert local meters (x east, y north) around a center to [lon, lat]. */
export function localToLonLat(center, x, y) {
  const lat = center[1] + y / (R * D2R);
  const lon = center[0] + x / (R * D2R * Math.cos(center[1] * D2R));
  return [+lon.toFixed(7), +lat.toFixed(7)];
}

// ---- editing operations on polygons (lon/lat) ----

export function translatePolygon(coords, dLon, dLat) {
  return coords.map((ring) => ring.map(([x, y]) => [+(x + dLon).toFixed(7), +(y + dLat).toFixed(7)]));
}

/** Rotate (degrees, clockwise on the map) and/or scale a polygon about its centroid. */
export function transformPolygon(coords, { rotateDeg = 0, scale = 1 } = {}) {
  const [cx, cy] = polygonCentroid(coords);
  const k = Math.cos(cy * D2R); // metres-per-degree ratio lon vs lat
  const a = -rotateDeg * D2R, cos = Math.cos(a), sin = Math.sin(a);
  return coords.map((ring) => ring.map(([x, y]) => {
    const u = (x - cx) * k, v = y - cy;
    const ru = (u * cos - v * sin) * scale, rv = (u * sin + v * cos) * scale;
    return [+(cx + ru / k).toFixed(7), +(cy + rv).toFixed(7)];
  }));
}

/** Rectangle of w × d metres centred on `center`, long side along `bearingDeg` (0 = north, clockwise). */
export function rectangleAt(center, w, d, bearingDeg = 0) {
  const b = bearingDeg * D2R;
  const ux = [Math.sin(b), Math.cos(b)], vx = [Math.cos(b), -Math.sin(b)]; // along, across (east,north)
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([a, c]) =>
    localToLonLat(center, a * ux[0] + c * vx[0], a * ux[1] + c * vx[1]));
  return [[...corners, corners[0]]];
}

export function lineLengthM(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
  return s;
}
