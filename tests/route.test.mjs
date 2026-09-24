import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTown } from '../src/data/generateTown.js';
import { buildGraph } from '../src/engine/graph.js';
import { shortestPath, planRoute, pointAlong, offsetPoint, bearingBetween } from '../src/engine/route.js';
import { newStreet } from '../src/engine/scenario.js';
import { haversine } from '../src/engine/geo.js';

const town = generateTown({ seed: 7 });
const streets = town.features.filter((f) => f.properties.kind === 'street');
const g = buildGraph(streets);

test('shortestPath finds a path and reports real metres', () => {
  const a = 0, b = Math.floor(g.size / 2);
  const p = shortestPath(g, a, b);
  assert.ok(p, 'path exists');
  assert.equal(p.nodes[0], a);
  assert.equal(p.nodes[p.nodes.length - 1], b);
  assert.equal(p.fids.length, p.nodes.length - 1);
  const straight = haversine(g.coords[a], g.coords[b]);
  assert.ok(p.meters >= straight * 0.95, 'never shorter than straight line');
  assert.ok(p.meters <= straight * 3, 'not absurdly long');
  assert.ok(p.cost >= p.meters * 0.8, 'cost tracks metres');
  assert.deepEqual(shortestPath(g, a, a), { nodes: [a], cost: 0, meters: 0, fids: [], from: a, to: a });
});

test('planRoute: waypoints → polyline with cumulative distance and street list', () => {
  const a = g.coords[3], b = g.coords[Math.floor(g.size * 0.7)];
  const r = planRoute(g, streets, [a, b]);
  assert.ok(r && !r.unreachable);
  assert.ok(r.coords.length >= 2);
  assert.equal(r.cum.length, r.coords.length);
  assert.ok(Math.abs(r.length - r.meters) < 2, `drawn length ${r.length} ≈ metres ${r.meters}`);
  assert.ok(r.minutes > 0 && r.walkMinutes > 0);
  assert.ok(r.streets.length >= 1);
  const sum = r.streets.reduce((s, x) => s + x.meters, 0);
  assert.ok(Math.abs(sum - r.length) < 2, 'street list covers the route');
  for (const s of r.streets) assert.ok(s.meters > 0);
  assert.equal(planRoute(g, streets, [a]), null);
});

test('planRoute through a via point is longer than direct and pointAlong walks it', () => {
  const a = g.coords[3], b = g.coords[Math.floor(g.size * 0.7)], via = g.coords[Math.floor(g.size * 0.3)];
  const direct = planRoute(g, streets, [a, b]);
  const viaR = planRoute(g, streets, [a, via, b]);
  assert.equal(viaR.legs.length, 2);
  assert.ok(viaR.meters >= direct.meters - 1e-6);
  const start = pointAlong(direct, 0), mid = pointAlong(direct, direct.length / 2), end = pointAlong(direct, direct.length + 100);
  assert.deepEqual(start.pos, direct.coords[0]);
  assert.deepEqual(end.pos, direct.coords[direct.coords.length - 1]);
  assert.ok(mid.bearing >= 0 && mid.bearing < 360);
  // the midpoint lies on the line: distance to its segment endpoints adds up
  const [p, q] = [direct.coords[mid.i], direct.coords[mid.i + 1]];
  assert.ok(Math.abs(haversine(p, mid.pos) + haversine(mid.pos, q) - haversine(p, q)) < 0.5);
});

test('a new footpath that shortcuts a route makes it shorter', () => {
  // pick two nodes, then draw a straight footpath directly between them
  const a = g.coords[10], b = g.coords[Math.floor(g.size * 0.6)];
  const before = planRoute(g, streets, [a, b]);
  const path = newStreet([a, b]);
  const g2 = buildGraph([...streets, path]);
  const after = planRoute(g2, [...streets, path], [a, b]);
  assert.ok(after.meters < before.meters, `${after.meters} < ${before.meters}`);
  assert.ok(after.streets.some((s) => s.added), 'route uses the drawn path');
});

test('geo helpers: offsetPoint and bearingBetween round-trip', () => {
  const p = [-70.5, 43.4];
  const q = offsetPoint(p, 100, 90);
  assert.ok(Math.abs(haversine(p, q) - 100) < 0.5);
  assert.ok(Math.abs(bearingBetween(p, q) - 90) < 0.5);
  const n = offsetPoint(p, 50, 0);
  assert.ok(Math.abs(bearingBetween(p, n)) < 0.5);
});

test('stops attach to the exact spot on a street, not the nearest vertex', async () => {
  const { makeSnapper } = await import('../src/engine/snap.js');
  const snap = makeSnapper(streets);
  // a point 40% along the first segment of a long street
  const f = streets.find((s) => s.geometry.coordinates.length >= 2 && haversine(s.geometry.coordinates[0], s.geometry.coordinates[1]) > 60);
  const [p0, p1] = f.geometry.coordinates;
  const mid = [p0[0] + (p1[0] - p0[0]) * 0.4, p0[1] + (p1[1] - p0[1]) * 0.4];
  const far = g.coords[Math.floor(g.size * 0.8)];
  const r = planRoute(g, streets, [mid, far], snap);
  assert.ok(r && !r.unreachable);
  assert.ok(!r.streets.some((s) => s.id === null && s.meters > 5), `no long off-street stub: ${JSON.stringify(r.streets.slice(0, 2))}`);
  assert.equal(r.streets[0].id, f.properties.id, 'route starts on the street the stop sits on');
  // two stops on the same segment walk straight along it
  const q = [p0[0] + (p1[0] - p0[0]) * 0.8, p0[1] + (p1[1] - p0[1]) * 0.8];
  const r2 = planRoute(g, streets, [mid, q], snap);
  assert.ok(Math.abs(r2.meters - haversine(mid, q)) < 1, `${r2.meters} vs ${haversine(mid, q)}`);
});
