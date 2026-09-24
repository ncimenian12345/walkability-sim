import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTown } from '../src/data/generateTown.js';
import { buildGraph, attachBuildings } from '../src/engine/graph.js';
import { multiSourceDijkstra } from '../src/engine/dijkstra.js';
import { computeMetrics } from '../src/engine/metrics.js';
import { makeSnapper } from '../src/engine/snap.js';
import { translatePolygon, transformPolygon, rectangleAt, polygonAreaM2, polygonCentroid, haversine } from '../src/engine/geo.js';
import { EMPTY_SCENARIO, applyScenario, patchFeature, revertFeature, newBuilding, newStreet, describeChanges, normalizeScenario } from '../src/engine/scenario.js';
import { convertOverpass, useFromTags } from '../src/data/osm.js';

const town = generateTown({ seed: 7 });
const streets = town.features.filter((f) => f.properties.kind === 'street');
const buildings = town.features.filter((f) => f.properties.kind === 'building');
const baseById = new Map([...buildings, ...streets].map((f) => [f.properties.id, f]));

test('scenario: edit, delete, add, revert', () => {
  const g = buildings.find((b) => b.properties.use === 'grocery');
  let s = patchFeature(EMPTY_SCENARIO, baseById, g.properties.id, { use: 'cafe' });
  assert.equal(applyScenario(buildings, s, 'building').find((b) => b.properties.id === g.properties.id).properties.use, 'cafe');
  // setting it back to the original drops the diff entirely
  s = patchFeature(s, baseById, g.properties.id, { use: 'grocery' });
  assert.deepEqual(s.mods, {});

  s = patchFeature(s, baseById, g.properties.id, { deleted: true });
  assert.equal(applyScenario(buildings, s, 'building').length, buildings.length - 1);
  assert.match(describeChanges(s, baseById)[0].detail, /removed/);
  s = revertFeature(s, g.properties.id);
  assert.equal(applyScenario(buildings, s, 'building').length, buildings.length);

  const nb = newBuilding(rectangleAt(town.properties.center, 20, 10, 30), 'pharmacy');
  s = { ...s, added: [nb] };
  assert.equal(applyScenario(buildings, s, 'building').length, buildings.length + 1);
  assert.ok(Math.abs(nb.properties.footprintM2 - 200) < 3, `area ${nb.properties.footprintM2}`);
  s = patchFeature(s, baseById, nb.properties.id, { levels: 3 });
  assert.equal(s.added[0].properties.levels, 3);
  s = patchFeature(s, baseById, nb.properties.id, { deleted: true });
  assert.equal(s.added.length, 0);
});

test('scenario: old {edits} format still loads', () => {
  const s = normalizeScenario({ edits: { b1: { use: 'cafe', levels: 1 } } });
  assert.deepEqual(s, { mods: { b1: { use: 'cafe', levels: 1 } }, added: [] });
});

test('geometry: move, rotate, scale keep shape sensible', () => {
  const c = rectangleAt([-70.545, 43.384], 30, 10, 0);
  const a0 = polygonAreaM2(c);
  const moved = translatePolygon(c, 0.001, 0);
  assert.ok(Math.abs(polygonAreaM2(moved) - a0) < 1);
  const rot = transformPolygon(c, { rotateDeg: 90 });
  assert.ok(Math.abs(polygonAreaM2(rot) - a0) < 2, 'rotation preserves area');
  const big = transformPolygon(c, { scale: 2 });
  assert.ok(Math.abs(polygonAreaM2(big) - 4 * a0) < 8, 'scale 2 → 4× area');
  // rotated rectangle's centroid is unchanged
  const [x0, y0] = polygonCentroid(c), [x1, y1] = polygonCentroid(rot);
  assert.ok(haversine([x0, y0], [x1, y1]) < 0.5);
});

test('network: a drawn footpath splices into the streets it touches and shortens walks', () => {
  // two nodes on different parallel avenues: shortest path must go round the block
  const g0 = buildGraph(streets);
  const snap = makeSnapper(streets);
  // pick a point halfway between Main St and the next avenue, mid-block
  const main = streets.find((s) => s.properties.name === 'Main St');
  const water = streets.find((s) => s.properties.name === 'Water St');
  const a = main.geometry.coordinates[3], b = main.geometry.coordinates[4];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const pA = snap(mid, 5);
  assert.ok(pA.snapped && pA.kind === 'segment');
  // the corresponding point on Water St
  const pB = snap([mid[0] + (water.geometry.coordinates[0][0] - main.geometry.coordinates[0][0]), mid[1] + (water.geometry.coordinates[0][1] - main.geometry.coordinates[0][1])], 40);
  assert.ok(pB.snapped, 'found Water St');

  const path = newStreet([pA.point, pB.point]);
  const g1 = buildGraph([...streets, path]);
  const n1 = g1.nearestNode(pA.point).node, n2 = g1.nearestNode(pB.point).node;
  const dWith = multiSourceDijkstra(g1, [[n1, 0]])[n2];
  const straight = haversine(pA.point, pB.point);
  assert.ok(dWith < straight * 1.05, `with path ${dWith.toFixed(0)} m vs straight ${straight.toFixed(0)} m`);

  const m0 = g0.nearestNode(pA.point), m1 = g0.nearestNode(pB.point);
  const dWithout = multiSourceDijkstra(g0, [[m0.node, 0]])[m1.node] + m0.dist + m1.dist;
  assert.ok(dWithout > dWith * 1.3, `without ${dWithout.toFixed(0)} m should be much longer than ${dWith.toFixed(0)} m`);
});

test('network: removing a street changes reachability', () => {
  const g = buildGraph(streets);
  const attach = attachBuildings(g, buildings);
  const base = computeMetrics(g, attach, buildings);
  // remove every street segment of Main St
  let s = EMPTY_SCENARIO;
  for (const f of streets.filter((x) => x.properties.name === 'Main St')) s = patchFeature(s, baseById, f.properties.id, { deleted: true });
  const st2 = applyScenario(streets, s, 'street');
  assert.equal(st2.length, streets.length - 1);
  const g2 = buildGraph(st2);
  const m2 = computeMetrics(g2, attachBuildings(g2, buildings), buildings);
  assert.ok(m2.summary.avgScore <= base.summary.avgScore);
});

test('osm: tags map to uses; POIs move onto their building', () => {
  assert.equal(useFromTags({ shop: 'supermarket' }), 'grocery');
  assert.equal(useFromTags({ amenity: 'cafe' }), 'cafe');
  assert.equal(useFromTags({ building: 'house' }), 'residential');
  assert.equal(useFromTags({ building: 'shed' }), null);
  const sq = (x, y, d = 0.0001) => [{ lon: x, lat: y }, { lon: x + d, lat: y }, { lon: x + d, lat: y + d }, { lon: x, lat: y + d }, { lon: x, lat: y }];
  const data = { elements: [
    { type: 'way', id: 1, tags: { building: 'yes' }, geometry: sq(-70.5, 43.4) },
    { type: 'way', id: 2, tags: { building: 'shed' }, geometry: sq(-70.501, 43.4) },
    { type: 'way', id: 3, tags: { highway: 'residential', name: 'Main St' }, geometry: [{ lon: -70.502, lat: 43.3995 }, { lon: -70.498, lat: 43.3995 }] },
    { type: 'node', id: 4, lon: -70.49995, lat: 43.40005, tags: { amenity: 'pharmacy', name: 'Rx' } },
    { type: 'node', id: 5, lon: -70.49, lat: 43.41, tags: { highway: 'bus_stop' } },
  ] };
  const t = convertOverpass(data, { name: 'Test', center: [-70.5, 43.4], bbox: [-70.51, 43.39, -70.49, 43.41] });
  const bs = t.features.filter((f) => f.properties.kind === 'building');
  assert.equal(bs.find((b) => b.properties.id === 'b1').properties.use, 'pharmacy');
  assert.equal(bs.find((b) => b.properties.id === 'b1').properties.name, 'Rx');
  assert.ok(!bs.some((b) => b.properties.id === 'b2'), 'shed skipped');
  assert.ok(bs.some((b) => b.properties.use === 'transit'), 'bus stop kept as a point amenity');
  assert.equal(t.features.filter((f) => f.properties.kind === 'street').length, 1);
  assert.equal(t.properties.source, 'openstreetmap');
});

test('osm: several unmatched POIs do not crash the matcher', async () => {
  const data = { elements: [
    { type: 'node', id: 1, lon: -70.5, lat: 43.4, tags: { amenity: 'cafe' } },
    { type: 'node', id: 2, lon: -70.51, lat: 43.41, tags: { shop: 'bakery' } },
    { type: 'node', id: 3, lon: -70.52, lat: 43.42, tags: { amenity: 'bank' } },
  ] };
  const t = convertOverpass(data, { name: 'T', center: [-70.5, 43.4] });
  assert.equal(t.features.filter((f) => f.properties.point).length, 3);
});

test('structures: FEMA footprints replace OSM outlines and inherit OSM names/uses', async () => {
  const { mergeStructures, femaUse } = await import('../src/data/structures.js');
  assert.equal(femaUse({ PRIM_OCC: 'Single Family Dwelling' }), 'residential');
  assert.equal(femaUse({ PRIM_OCC: 'Unclassified', SQMETERS: 30 }), null);
  const sq = (x, y, d = 0.0002) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
  const town = { type: 'FeatureCollection', properties: { center: [-70.5, 43.4], attribution: 'OSM' }, features: [
    { type: 'Feature', properties: { kind: 'street', id: 's1', highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[-70.501, 43.3995], [-70.498, 43.3995]] } },
    { type: 'Feature', properties: { kind: 'building', id: 'b1', use: 'cafe', levels: 1, name: 'Bean', footprintM2: 300 }, geometry: { type: 'Polygon', coordinates: [sq(-70.5, 43.4)] } },
    { type: 'Feature', properties: { kind: 'building', id: 'b2', use: 'park', levels: 0, name: 'Green', footprintM2: 900 }, geometry: { type: 'Polygon', coordinates: [sq(-70.499, 43.4, 0.0005)] } },
    { type: 'Feature', properties: { kind: 'building', id: 'p1', use: 'pharmacy', levels: 0, name: 'Rx', footprintM2: 16, point: true }, geometry: { type: 'Polygon', coordinates: [sq(-70.49745, 43.40005, 0.00001)] } },
    { type: 'Feature', properties: { kind: 'building', id: 'p2', use: 'transit', levels: 0, name: 'Walgreens', footprintM2: 16, point: true }, geometry: { type: 'Polygon', coordinates: [sq(-70.49848, 43.40102, 0.00001)] } },
  ] };
  const fema = [
    { type: 'Feature', properties: { BUILD_ID: 1, OCC_CLS: 'Commercial', PRIM_OCC: 'Retail Trade', SQMETERS: 280 }, geometry: { type: 'Polygon', coordinates: [sq(-70.49999, 43.40001, 0.00018)] } },
    { type: 'Feature', properties: { BUILD_ID: 2, OCC_CLS: 'Residential', PRIM_OCC: 'Single Family Dwelling', SQMETERS: 120, POP_MEDIAN: 3 }, geometry: { type: 'Polygon', coordinates: [sq(-70.4985, 43.401, 0.0001)] } },
    { type: 'Feature', properties: { BUILD_ID: 3, OCC_CLS: 'Commercial', PRIM_OCC: 'Retail Trade', SQMETERS: 200 }, geometry: { type: 'Polygon', coordinates: [sq(-70.4975, 43.4, 0.0001)] } },
  ];
  const m = mergeStructures(town, fema);
  const bs = m.features.filter((f) => f.properties.kind === 'building');
  const byId = Object.fromEntries(bs.map((b) => [b.properties.id, b.properties]));
  assert.ok(!byId.b1, 'OSM outline replaced');
  assert.equal(byId.f1.use, 'cafe');
  assert.equal(byId.f1.name, 'Bean');
  assert.equal(byId.f2.pop, 3);
  assert.equal(byId.f3.use, 'pharmacy', 'point business moved into the FEMA building it sits in');
  assert.ok(byId.b2, 'park kept');
  assert.equal(byId.f2.use, 'residential', 'bus stop named after a nearby place does not rename the building');
  assert.equal(byId.f2.name, null);
  assert.ok(byId.p2, 'bus stop kept as its own point');
  assert.equal(m.features.filter((f) => f.properties.kind === 'street').length, 1);
});
