#!/usr/bin/env node
// Fetch real buildings, streets and businesses from OpenStreetMap into public/data/town.json.
// (The app can also do this itself: Town → "Load real buildings for this view".)
//
//   npm run fetch-town                                             # downtown Kennebunk, ME
//   npm run fetch-town -- "Portland, Maine" --radius 1500          # 1.5 km around a place
//   npm run fetch-town -- --bbox -70.5625,43.3715,-70.5275,43.3960 # west,south,east,north

import { writeFileSync, mkdirSync } from 'node:fs';
import { geocode, fetchTownBBox, KENNEBUNK_BBOX } from '../src/data/osm.js';

const headers = { 'User-Agent': 'walkability-sim/0.2 (town planning research)' };
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const place = args.find((a, i) => !a.startsWith('--') && !['--radius', '--bbox', '--out'].includes(args[i - 1]));
const out = opt('--out') || 'public/data/town.json';

async function main() {
  let bbox, name;
  if (opt('--bbox')) {
    bbox = opt('--bbox').split(',').map(Number);
    name = place || 'Custom area';
  } else if (!place) {
    bbox = KENNEBUNK_BBOX;
    name = 'Kennebunk, Maine';
  } else {
    const hit = await geocode(place, { headers });
    const r = Number(opt('--radius') || 1400);
    const dLat = r / 110540, dLon = r / (111320 * Math.cos((hit.center[1] * Math.PI) / 180));
    bbox = [hit.center[0] - dLon, hit.center[1] - dLat, hit.center[0] + dLon, hit.center[1] + dLat];
    name = hit.name.split(',').slice(0, 2).join(',');
  }
  console.log(`Fetching ${name} [${bbox.map((v) => v.toFixed(4)).join(', ')}] from OpenStreetMap…`);
  const town = await fetchTownBBox(bbox, { name, headers });
  mkdirSync('public/data', { recursive: true });
  writeFileSync(out, JSON.stringify(town));
  const count = (k) => town.features.filter((f) => f.properties.kind === k).length;
  console.log(`Wrote ${out}: ${count('building')} buildings, ${count('street')} street/path segments.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
