import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTown } from '../src/data/generateTown.js';
import { buildGraph, attachBuildings } from '../src/engine/graph.js';
import { multiSourceDijkstra } from '../src/engine/dijkstra.js';
import { computeMetrics, withUse, decay } from '../src/engine/metrics.js';
import { haversine } from '../src/engine/geo.js';

const town = generateTown({ seed: 7 });
const streets = town.features.filter((f) => f.properties.kind === 'street');
const buildings = town.features.filter((f) => f.properties.kind === 'building');

test('generated town has a sensible shape', () => {
  assert.ok(buildings.length > 500);
  assert.ok(streets.length > 20);
  assert.ok(buildings.some((b) => b.properties.use === 'grocery'));
  const ids = new Set(buildings.map((b) => b.properties.id));
  assert.equal(ids.size, buildings.length, 'building ids are unique');
});

test('graph is connected and edge weights are metric', () => {
  const g = buildGraph(streets);
  assert.ok(g.size > 50);
  const dist = multiSourceDijkstra(g, [[0, 0]]);
  const reachable = dist.filter((d) => d < Infinity).length;
  assert.ok(reachable / g.size > 0.95, `only ${reachable}/${g.size} nodes reachable`);
  // an edge weight should be within ~2x of straight-line distance (penalties only lengthen)
  const [v, w] = g.adj[0][0];
  const straight = haversine(g.coords[0], g.coords[v]);
  assert.ok(w >= straight * 0.8 && w <= straight * 2, `weight ${w} vs straight ${straight}`);
});

test('metrics: every building attached; scores in range; coverage responds to edits', () => {
  const g = buildGraph(streets);
  const attach = attachBuildings(g, buildings);
  assert.equal(attach.size, buildings.length);
  for (const a of attach.values()) assert.ok(a.offset < 400, 'building within 400 m of the network');

  const m = computeMetrics(g, attach, buildings);
  assert.ok(m.summary.population > 1000);
  assert.ok(m.summary.avgScore >= 0 && m.summary.avgScore <= 100);
  for (const r of m.perBuilding.values()) assert.ok(r.score >= 0 && r.score <= 100);
  const groceryBefore = m.summary.coverage.grocery.share;

  // Put a grocery right downtown: grocery coverage must rise, score must not drop
  const downtown = buildings.find((b) => b.properties.use === 'retail');
  const edited = buildings.map((b) => (b === downtown ? withUse(b, 'grocery') : b));
  const m2 = computeMetrics(g, attach, edited);
  assert.ok(m2.summary.coverage.grocery.share > groceryBefore, 'grocery coverage increased');
  assert.ok(m2.summary.avgScore >= m.summary.avgScore);
  assert.equal(m2.summary.useCounts.grocery, 2);

  // Remove all groceries: coverage drops to zero and minutes become Infinity
  const none = buildings.map((b) => (b.properties.use === 'grocery' ? withUse(b, 'vacant') : b));
  const m3 = computeMetrics(g, attach, none);
  assert.equal(m3.summary.coverage.grocery.share, 0);
  assert.equal(m3.perBuilding.get(buildings[0].properties.id).minutes.grocery, Infinity);
});

test('decay curve', () => {
  assert.equal(decay(0), 1);
  assert.equal(decay(400), 1);
  assert.ok(Math.abs(decay(1600) - 0.12) < 1e-9);
  assert.equal(decay(3000), 0);
});

test('performance: full recompute under 250 ms on the sample town', () => {
  const g = buildGraph(streets);
  const attach = attachBuildings(g, buildings);
  const t0 = performance.now();
  computeMetrics(g, attach, buildings);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `took ${ms.toFixed(0)} ms`);
});
