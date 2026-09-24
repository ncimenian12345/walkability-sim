// Street-level "walk mode" camera for MapLibre.
//
// MapLibre's camera looks at `center` from a distance set by zoom and pitch, so to
// stand at a point on the ground we place `center` a little way ahead of the walker
// and pick the zoom that puts the camera eye at the wanted height. Along a planned
// route the walker follows the line at walking pace; otherwise WASD / arrow keys
// move it freely and dragging the map looks around.

import { pointAlong, offsetPoint } from '../engine/route.js';
import { WALK_SPEED_M_PER_MIN } from '../data/uses.js';

const FOV = 0.6435011087932844;              // MapLibre's default vertical field of view (rad)
const WALK_M_PER_S = WALK_SPEED_M_PER_MIN / 60;
const TURN_DEG_PER_S = 110;
const LOOK_AHEAD_M = 8;                      // smooths the heading around corners on a route
const EMIT_MS = 120;

export const EYE_PRESETS = [
  { id: 'street', label: 'Street level', eye: 2.2, pitch: 84 },
  { id: 'balcony', label: 'Second floor', eye: 6, pitch: 78 },
  { id: 'drone', label: 'Low drone', eye: 25, pitch: 65 },
];
export const SPEEDS = [1, 2, 4, 8];

const norm = (a) => ((a % 360) + 360) % 360;
const turnToward = (from, to, maxStep) => {
  let d = norm(to - from);
  if (d > 180) d -= 360;
  return norm(from + Math.max(-maxStep, Math.min(maxStep, d)));
};

export function createWalker(map, { onUpdate }) {
  const st = {
    active: false, mode: 'free', route: null, d: 0, pos: null, heading: 0,
    eye: EYE_PRESETS[0].eye, pitch: EYE_PRESETS[0].pitch, preset: 'street',
    speed: 2, playing: false, keys: new Set(),
  };
  let raf = 0, lastT = 0, lastEmit = 0, saved = null, dragging = null;
  const canvas = map.getCanvas();
  const HANDLERS = ['dragPan', 'dragRotate', 'scrollZoom', 'keyboard', 'doubleClickZoom', 'touchZoomRotate', 'boxZoom', 'touchPitch'];

  function applyCamera() {
    const P = (st.pitch * Math.PI) / 180;
    const dM = st.eye / Math.cos(P);            // eye → look-at point, metres
    const ahead = dM * Math.sin(P);             // horizontal part of that
    const center = offsetPoint(st.pos, ahead, st.heading);
    const h = canvas.clientHeight || 800;
    const dPx = (0.5 * h) / Math.tan(FOV / 2);  // eye → center in CSS pixels at the center's depth
    const mpp = dM / dPx;
    const zoom = Math.log2((40075016.686 * Math.cos((center[1] * Math.PI) / 180)) / (512 * mpp));
    map.jumpTo({ center, zoom: Math.min(24, zoom), bearing: st.heading, pitch: st.pitch });
  }

  function snapshot() {
    return {
      pos: st.pos, heading: st.heading, d: st.d, length: st.route ? st.route.length : 0, mode: st.mode,
      playing: st.playing, speed: st.speed, preset: st.preset, eye: st.eye,
      elapsedMin: st.d / WALK_SPEED_M_PER_MIN,
    };
  }
  const emit = (force) => {
    const now = performance.now();
    if (!force && now - lastEmit < EMIT_MS) return;
    lastEmit = now;
    onUpdate(snapshot());
  };

  function frame(t) {
    const dt = Math.min(0.1, lastT ? (t - lastT) / 1000 : 0);
    lastT = t;
    const k = st.keys;
    const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const turn = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const strafe = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    const run = k.has('shift') ? 3 : 1;
    if (fwd || turn || strafe) {
      if (st.mode === 'route') { st.mode = 'free'; st.playing = false; } // stepping off the route
      st.heading = norm(st.heading + turn * TURN_DEG_PER_S * dt);
      const step = WALK_M_PER_S * run * st.speed * dt;
      if (fwd) st.pos = offsetPoint(st.pos, fwd * step, st.heading);
      if (strafe) st.pos = offsetPoint(st.pos, strafe * step, st.heading + 90);
    } else if (st.mode === 'route' && st.playing) {
      st.d = Math.min(st.route.length, st.d + WALK_M_PER_S * st.speed * dt);
      if (st.d >= st.route.length) st.playing = false;
      placeOnRoute(dt);
    }
    applyCamera();
    emit(false);
    raf = requestAnimationFrame(frame);
  }

  function placeOnRoute(dt = 1) {
    const here = pointAlong(st.route, st.d);
    const next = pointAlong(st.route, Math.min(st.route.length, st.d + LOOK_AHEAD_M));
    st.pos = here.pos;
    const target = st.d + LOOK_AHEAD_M >= st.route.length ? here.bearing : bearingTo(here.pos, next.pos, here.bearing);
    st.heading = dt >= 1 ? target : turnToward(st.heading, target, 240 * dt);
  }
  function bearingTo(a, b, fallback) {
    const cosLat = Math.cos((a[1] * Math.PI) / 180);
    const dx = (b[0] - a[0]) * cosLat, dy = b[1] - a[1];
    if (Math.abs(dx) + Math.abs(dy) < 1e-9) return fallback;
    return norm((Math.atan2(dx, dy) * 180) / Math.PI);
  }

  // ---- input ----
  const onKeyDown = (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    const key = e.key.toLowerCase();
    if (key === ' ') { e.preventDefault(); if (st.route) api.setPlaying(!st.playing); return; }
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      e.preventDefault();
      st.keys.add(key);
    }
  };
  const onKeyUp = (e) => st.keys.delete(e.key.toLowerCase());
  const onBlur = () => st.keys.clear();
  const onPointerDown = (e) => { if (e.button === 0) { dragging = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture?.(e.pointerId); } };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    dragging = { x: e.clientX, y: e.clientY };
    st.heading = norm(st.heading - dx * 0.25);
    st.pitch = Math.max(45, Math.min(85, st.pitch + dy * 0.12));
    if (st.mode === 'route' && st.playing && Math.abs(dx) > 0) st.playing = false; // looking around pauses the walk
  };
  const onPointerUp = () => { dragging = null; };
  const onWheel = (e) => {
    e.preventDefault();
    st.eye = Math.max(1.6, Math.min(60, st.eye * (e.deltaY > 0 ? 1.12 : 0.9)));
    st.preset = null;
  };

  const api = {
    get active() { return st.active; },
    /** @param {{route?:object, pos?:number[], heading?:number}} o */
    start(o = {}) {
      if (!st.active) {
        saved = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), maxPitch: map.getMaxPitch(), maxZoom: map.getMaxZoom() };
        map.setMaxPitch(85);
        map.setMaxZoom(24);
        for (const h of HANDLERS) map[h]?.disable();
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.style.cursor = 'grab';
        st.active = true;
      }
      st.route = o.route || null;
      st.d = 0;
      st.playing = false;
      if (st.route) { st.mode = 'route'; placeOnRoute(1); }
      else {
        st.mode = 'free';
        const c = map.getCenter();
        st.pos = o.pos || [c.lng, c.lat];
        st.heading = norm(o.heading ?? map.getBearing());
      }
      lastT = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
      emit(true);
    },
    stop() {
      if (!st.active) return;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.style.cursor = '';
      for (const h of HANDLERS) map[h]?.enable();
      map.setMaxPitch(saved?.maxPitch ?? 75);
      map.setMaxZoom(saved?.maxZoom ?? 22);
      st.active = false;
      st.keys.clear();
      // come back up to an overview of where the walker ended
      map.easeTo({ center: st.pos, zoom: Math.min(saved?.zoom ?? 17, 17.5), pitch: Math.min(saved?.pitch ?? 50, 60), bearing: st.heading, duration: 900 });
    },
    setPlaying(on) { if (!st.route) return; if (on && st.d >= st.route.length) st.d = 0; st.mode = 'route'; st.playing = on; if (!on) emit(true); },
    setSpeed(s) { st.speed = s; emit(true); },
    seek(d) { if (!st.route) return; st.d = Math.max(0, Math.min(st.route.length, d)); st.mode = 'route'; placeOnRoute(1); emit(true); },
    setPreset(id) { const p = EYE_PRESETS.find((x) => x.id === id); if (!p) return; st.eye = p.eye; st.pitch = p.pitch; st.preset = id; emit(true); },
    /** Re-attach to a (re)planned route while walking, keeping progress where possible. */
    setRoute(route) { st.route = route; if (!route) { st.mode = 'free'; st.playing = false; return; } st.d = Math.min(st.d, route.length); if (st.mode === 'route') placeOnRoute(1); emit(true); },
    state: snapshot,
  };
  return api;
}
