// Writes the procedural stand-in town to public/data/town.json.
// Usage: node scripts/generate-town.mjs [seed]
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateTown } from '../src/data/generateTown.js';

const seed = Number(process.argv[2] ?? 7);
const town = generateTown({ seed });
mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/town.json', JSON.stringify(town));
const b = town.features.filter((f) => f.properties.kind === 'building').length;
const s = town.features.filter((f) => f.properties.kind === 'street').length;
console.log(`Wrote public/data/town.json — ${b} buildings, ${s} street segments`);
