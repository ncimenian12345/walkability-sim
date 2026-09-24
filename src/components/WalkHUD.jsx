import { useMemo } from 'react';
import { USES } from '../data/uses.js';
import { polygonCentroid, fastDist } from '../engine/geo.js';
import { EYE_PRESETS, SPEEDS } from './walker.js';

const NEARBY_M = 150;
const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const fmtMin = (m) => `${Math.round(m)} min`;
const HIGHWAY_LABEL = { footway: 'footpath', path: 'path', pedestrian: 'pedestrian street', living_street: 'living street', residential: 'residential street', service: 'service road', unclassified: 'minor road', tertiary: 'connector road', secondary: 'main road', primary: 'main road', trunk: 'highway', cycleway: 'cycle path', steps: 'steps', track: 'track' };
const SIDEWALK_LABEL = { both: 'sidewalks both sides', left: 'sidewalk one side', right: 'sidewalk one side', yes: 'has sidewalk', separate: 'separate sidewalk', no: 'no sidewalk', none: 'no sidewalk' };

/**
 * Overlay shown while walking: where you are, what is around you, route progress
 * and playback controls. `state` comes from the walker (see walker.js).
 */
export default function WalkHUD({ state, route, baseRoute, streetById, snap, buildings, walker, onExit }) {
  const posKey = state.pos ? `${state.pos[0].toFixed(5)},${state.pos[1].toFixed(5)}` : '';

  // Street underfoot and amenities within a short stroll — recomputed as you move.
  const here = useMemo(() => {
    if (!state.pos) return { street: null, nearby: [] };
    const s = snap(state.pos, 25);
    const street = s.snapped ? streetById.get(s.streetId) : null;
    const cosLat = Math.cos((state.pos[1] * Math.PI) / 180);
    const nearby = [];
    for (const f of buildings) {
      const u = USES[f.properties.use];
      if (!u?.category) continue;
      const d = fastDist(state.pos, polygonCentroid(f.geometry.coordinates), cosLat);
      if (d <= NEARBY_M) nearby.push({ id: f.properties.id, name: f.properties.name || u.label, use: u.label, color: u.color, d });
    }
    nearby.sort((a, b) => a.d - b.d);
    return { street, nearby: nearby.slice(0, 6), nearbyCount: nearby.length };
  }, [posKey, snap, streetById, buildings]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRoute = !!route && state.mode === 'route';
  const progress = route ? Math.min(1, state.d / Math.max(1, route.length)) : 0;
  const remainingMin = route ? Math.max(0, (route.length - state.d) / 80) : 0;
  const sp = here.street?.properties;

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="hud-card hud-where">
          <div className="hud-eyebrow">{onRoute ? 'Walking route' : 'Free walk'} · {state.heading != null ? compass(state.heading) : ''}</div>
          <div className="hud-title">{sp ? (sp.name || `Unnamed ${HIGHWAY_LABEL[sp.highway] || sp.highway}`) : 'Off the street network'}</div>
          {sp && <div className="hud-sub">{HIGHWAY_LABEL[sp.highway] || sp.highway}{sp.sidewalk ? ` · ${SIDEWALK_LABEL[sp.sidewalk] || sp.sidewalk}` : ' · sidewalk unknown'}{sp.added ? ' · added in this scenario' : ''}</div>}
        </div>
        <div className="hud-card hud-nearby">
          <div className="hud-eyebrow">Within {NEARBY_M} m ({here.nearbyCount || 0})</div>
          {here.nearby.length === 0 && <div className="hud-sub">No shops or services in sight.</div>}
          <ul>
            {here.nearby.map((n) => (
              <li key={n.id}><span className="swatch" style={{ background: n.color }} /><span className="hud-name">{n.name}</span><span className="muted">{n.use} · {fmtM(n.d)}</span></li>
            ))}
          </ul>
        </div>
        <button className="hud-exit" onClick={onExit} title="Back to the map (Esc)">✕ Exit walk</button>
      </div>

      <div className="hud-bottom">
        {route && (
          <div className="hud-card hud-route">
            <div className="row-between">
              <div>
                <b>{fmtMin(state.elapsedMin)}</b> walked · <b>{fmtMin(remainingMin)}</b> to go · {fmtM(state.d)} of {fmtM(route.length)}
                {baseRoute && Math.abs(baseRoute.minutes - route.minutes) >= 0.5 && (
                  <span className={`delta ${route.minutes < baseRoute.minutes ? 'up' : 'down'}`}> {route.minutes < baseRoute.minutes ? '−' : '+'}{Math.round(Math.abs(route.minutes - baseRoute.minutes))} min vs. today</span>
                )}
              </div>
              {state.d >= route.length - 0.5 && <span className="pill">Arrived</span>}
            </div>
            <input className="hud-seek" type="range" min="0" max={Math.ceil(route.length)} step="1" value={Math.round(state.d)} onChange={(e) => walker.seek(Number(e.target.value))} style={{ '--p': `${progress * 100}%` }} />
            <div className="hud-controls">
              <button className="primary" onClick={() => walker.setPlaying(!state.playing)} title="Space">{state.playing ? '❚❚ Pause' : state.d >= route.length - 0.5 ? '↺ Replay' : '▶ Walk'}</button>
              {!onRoute && <button onClick={() => walker.seek(state.d)}>Back on route</button>}
              <span className="seg">
                {SPEEDS.map((s) => <button key={s} className={state.speed === s ? 'on' : ''} onClick={() => walker.setSpeed(s)}>{s}×</button>)}
              </span>
              <span className="seg">
                {EYE_PRESETS.map((p) => <button key={p.id} className={state.preset === p.id ? 'on' : ''} onClick={() => walker.setPreset(p.id)}>{p.label}</button>)}
              </span>
            </div>
          </div>
        )}
        {!route && (
          <div className="hud-card hud-route">
            <div className="hud-controls">
              <span className="seg">
                {EYE_PRESETS.map((p) => <button key={p.id} className={state.preset === p.id ? 'on' : ''} onClick={() => walker.setPreset(p.id)}>{p.label}</button>)}
              </span>
              <span className="seg">
                {SPEEDS.map((s) => <button key={s} className={state.speed === s ? 'on' : ''} onClick={() => walker.setSpeed(s)}>{s}×</button>)}
              </span>
            </div>
          </div>
        )}
        <div className="hud-keys muted small">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows to walk · <kbd>Shift</kbd> run · drag to look around · scroll for eye height{route ? <> · <kbd>Space</kbd> play/pause</> : null} · <kbd>Esc</kbd> exit
        </div>
      </div>
    </div>
  );
}

function compass(deg) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `facing ${names[((Math.round(deg / 45) % 8) + 8) % 8]}`;
}
