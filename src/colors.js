import { USES } from './data/uses.js';

function lerp(a, b, t) { return a + (b - a) * t; }
function hex(r, g, b) { return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join(''); }
function parse(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function mix(stops, t) {
  // stops: [[t, '#hex'], ...] sorted
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const u = (t - t0) / (t1 - t0);
      const a = parse(c0), b = parse(c1);
      return hex(lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u));
    }
  }
  return stops[stops.length - 1][1];
}

// Walk score 0 → 100 : red → amber → green
const SCORE_STOPS = [[0, '#c62828'], [35, '#ef6c00'], [55, '#fdd835'], [75, '#7cb342'], [100, '#1b5e20']];
export function scoreColor(score) { return mix(SCORE_STOPS, score); }

// Minutes to nearest amenity: 0–5 green, 15 amber, 30+ red, unreachable grey
const MIN_STOPS = [[3, '#1b5e20'], [8, '#7cb342'], [15, '#fdd835'], [22, '#ef6c00'], [30, '#c62828']];
export function minutesColor(min) { return min === Infinity || Number.isNaN(min) ? '#9e9e9e' : mix(MIN_STOPS, min); }

export function useColor(use) { return USES[use]?.color || '#bdbdbd'; }

export const NEUTRAL_BUILDING = '#cfd3d6';
