import { useState } from 'react';
import { USES, USE_KEYS, CATEGORIES, CATEGORY_KEYS, isResidential } from '../data/uses.js';
import { scoreColor, minutesColor } from '../colors.js';
import { lineLengthM } from '../engine/geo.js';

const fmtMin = (m) => (m === Infinity ? 'unreachable' : `${Math.round(m)} min`);

const TOOLS = [
  { id: 'select', icon: '↖', label: 'Select / move', key: 'V', hint: 'Click a building or street to edit it. Drag a selected building to move it. Delete key removes it.' },
  { id: 'paint', icon: '🖌', label: 'Paint use', key: 'P', hint: 'Click buildings to change them to the chosen use.' },
  { id: 'drop', icon: '▣', label: 'Drop building', key: 'D', hint: 'Click to place a building of the chosen use and size. It lines up with the nearest street.' },
  { id: 'draw', icon: '⬠', label: 'Draw building', key: 'B', hint: 'Click to add corners; click the first corner, double-click, or press Enter to finish. Backspace undoes a corner, Esc cancels.' },
  { id: 'path', icon: '〰', label: 'Add footpath', key: 'F', hint: 'Click to add points — they snap to streets (orange dot) so the path joins the walking network. Double-click or Enter to finish.' },
  { id: 'delete', icon: '✕', label: 'Remove', key: 'X', hint: 'Click a building or street segment to remove it. Removed items show as red dashed outlines; undo or revert to bring them back.' },
];

const HIGHWAYS = ['footway', 'path', 'pedestrian', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'cycleway', 'steps', 'track'];
const SIDEWALKS = [['', 'unknown'], ['both', 'both sides'], ['left', 'one side'], ['no', 'none']];

export default function Sidebar(p) {
  const {
    town, townStatus, buildingCount, onSearchPlace, onLoadView, onUseStandIn, onDownloadTown,
    tool, setTool, brushUse, setBrushUse, dropSize, setDropSize, canUndo, canRedo, onUndo, onRedo,
    selected, selectedResult, isChanged, onEdit, onTransform, onDuplicate, onDelete, onRevert, onDeselect,
    changes, onSelectChange, onResetAll, metrics, viewMode, setViewMode, layers, setLayers,
  } = p;
  const [query, setQuery] = useState('');
  const [showChanges, setShowChanges] = useState(true);
  const counts = metrics?.summary.useCounts || {};
  const generated = town.properties?.source === 'generated';
  const activeTool = TOOLS.find((t) => t.id === tool);
  const needsBrush = ['paint', 'drop', 'draw'].includes(tool);

  return (
    <aside className="panel panel-left">
      <header className="panel-header">
        <div className="row-between">
          <h1>{town.properties?.name || 'Town'}</h1>
          {import.meta.env.PROD && <a className="link small" href="/logout" title="Sign out of this device">Sign out</a>}
        </div>
        <p className="muted small">{buildingCount.toLocaleString()} buildings · {generated ? 'stylized stand-in (not real)' : town.properties?.footprints ? 'FEMA footprints + OpenStreetMap' : 'OpenStreetMap data'}</p>
      </header>

      <section>
        <h2>Town</h2>
        <form className="save-row" onSubmit={(e) => { e.preventDefault(); if (query.trim()) onSearchPlace(query.trim()); }}>
          <input placeholder="Search a town, e.g. Kennebunkport, ME" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" disabled={townStatus?.loading}>Go</button>
        </form>
        <button className="wide" onClick={onLoadView} disabled={townStatus?.loading}>Load real buildings for this view</button>
        {townStatus && <p className={`hint ${townStatus.error ? 'err' : ''}`}>{townStatus.loading && <span className="spinner" />}{townStatus.message}</p>}
        <div className="row-between small">
          {!generated && <button className="link" onClick={onDownloadTown}>Download town.json</button>}
          {!generated && <button className="link" onClick={onUseStandIn}>Use stand-in</button>}
        </div>
      </section>

      <section>
        <div className="row-between">
          <h2>Tools</h2>
          <div className="undo">
            <button onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">↶</button>
            <button onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)">↷</button>
          </div>
        </div>
        <div className="tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
              <span className="ti">{t.icon}</span><span>{t.label}</span>
            </button>
          ))}
        </div>
        {needsBrush && (
          <label>{tool === 'paint' ? 'Paint as' : 'New building use'}
            <select value={brushUse} onChange={(e) => setBrushUse(e.target.value)}>
              {USE_KEYS.map((k) => <option key={k} value={k}>{USES[k].label}</option>)}
            </select>
          </label>
        )}
        {tool === 'drop' && (
          <div className="size-row">
            <label>Width (m)<input type="number" min="3" max="200" value={dropSize.w} onChange={(e) => setDropSize({ ...dropSize, w: Math.max(3, Number(e.target.value)) })} /></label>
            <label>Depth (m)<input type="number" min="3" max="200" value={dropSize.d} onChange={(e) => setDropSize({ ...dropSize, d: Math.max(3, Number(e.target.value)) })} /></label>
          </div>
        )}
        <p className="hint">{activeTool.hint}</p>
      </section>

      {selected?.properties.kind === 'building' && (
        <section className="selected">
          <div className="row-between">
            <h2>{selected.properties.name || USES[selected.properties.use]?.label}</h2>
            <button className="link" onClick={onDeselect} title="Close">✕</button>
          </div>
          <label>Name
            <input value={selected.properties.name || ''} placeholder="(unnamed)" onChange={(e) => onEdit(selected.properties.id, { name: e.target.value || null })} />
          </label>
          <div className="size-row">
            <label>Use
              <select value={selected.properties.use} onChange={(e) => onEdit(selected.properties.id, { use: e.target.value })}>
                {USE_KEYS.map((k) => <option key={k} value={k}>{USES[k].label}</option>)}
              </select>
            </label>
            <label className="narrow">Storeys
              <input type="number" min="0" max="40" value={selected.properties.levels} onChange={(e) => onEdit(selected.properties.id, { levels: Math.max(0, Number(e.target.value)) })} />
            </label>
          </div>
          <div className="btn-row">
            <button onClick={() => onTransform(selected.properties.id, { rotateDeg: -15 })} title="Rotate left 15°">⟲ 15°</button>
            <button onClick={() => onTransform(selected.properties.id, { rotateDeg: 15 })} title="Rotate right 15°">⟳ 15°</button>
            <button onClick={() => onTransform(selected.properties.id, { scale: 0.9 })} title="Shrink 10%">− size</button>
            <button onClick={() => onTransform(selected.properties.id, { scale: 1.1 })} title="Grow 10%">+ size</button>
          </div>
          <div className="btn-row">
            <button onClick={() => onDuplicate(selected.properties.id)}>Duplicate</button>
            <button className="danger" onClick={() => onDelete('building', selected.properties.id)}>Remove</button>
            {isChanged && !selected.properties.added && <button onClick={() => onRevert(selected.properties.id)}>Revert</button>}
          </div>
          <div className="small muted">Footprint {selected.properties.footprintM2.toLocaleString()} m²{isResidential(selected.properties.use) && selectedResult ? ` · ~${selectedResult.residents} residents` : ''} · drag it on the map to move</div>
          {selectedResult && (
            <div className="minutes">
              {isResidential(selected.properties.use) && (
                <div className="score-line">Walk score <b style={{ color: scoreColor(selectedResult.score) }}>{selectedResult.score}</b>{selectedResult.hasAllEssentials ? ' · all essentials within 15 min' : ''}</div>
              )}
              <table>
                <tbody>
                  {CATEGORY_KEYS.map((k) => (
                    <tr key={k} className={viewMode === k ? 'hl' : ''} onClick={() => setViewMode(k)}>
                      <td>{CATEGORIES[k].label}{CATEGORIES[k].essential ? ' *' : ''}</td>
                      <td style={{ color: minutesColor(selectedResult.minutes[k]) }}>{fmtMin(selectedResult.minutes[k])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small muted">* essential for the 15‑minute test. Click a row to map it.</div>
            </div>
          )}
        </section>
      )}

      {selected?.properties.kind === 'street' && (
        <section className="selected">
          <div className="row-between">
            <h2>{selected.properties.name || `Unnamed ${selected.properties.highway}`}</h2>
            <button className="link" onClick={onDeselect} title="Close">✕</button>
          </div>
          <label>Name
            <input value={selected.properties.name || ''} placeholder="(unnamed)" onChange={(e) => onEdit(selected.properties.id, { name: e.target.value || null })} />
          </label>
          <div className="size-row">
            <label>Type
              <select value={selected.properties.highway} onChange={(e) => onEdit(selected.properties.id, { highway: e.target.value })}>
                {HIGHWAYS.map((h) => <option key={h} value={h}>{h.replace('_', ' ')}</option>)}
              </select>
            </label>
            <label>Sidewalk
              <select value={selected.properties.sidewalk || ''} onChange={(e) => onEdit(selected.properties.id, { sidewalk: e.target.value || null })}>
                {SIDEWALKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="small muted">{Math.round(lineLengthM(selected.geometry.coordinates))} m long. Busier types and missing sidewalks make walks along it count as longer.</div>
          <div className="btn-row">
            <button className="danger" onClick={() => onDelete('street', selected.properties.id)}>Remove segment</button>
            {isChanged && !selected.properties.added && <button onClick={() => onRevert(selected.properties.id)}>Revert</button>}
          </div>
        </section>
      )}

      <section>
        <div className="row-between">
          <h2 className="clickable" onClick={() => setShowChanges(!showChanges)}>{showChanges ? '▾' : '▸'} Changes <span className="pill muted">{changes.length}</span></h2>
          {changes.length > 0 && <button className="link" onClick={onResetAll}>Reset all</button>}
        </div>
        {showChanges && (changes.length === 0
          ? <p className="small muted">No changes yet. Everything you edit, add or remove shows up here.</p>
          : (
            <ul className="changes">
              {changes.map((c) => (
                <li key={c.id}>
                  <button className="link change-name" onClick={() => onSelectChange(c)}>{c.label}</button>
                  <span className="muted small">{c.detail}</span>
                  <button className="link" title={c.detail === 'added' ? 'Remove' : 'Revert'} onClick={() => onRevert(c.id)}>↺</button>
                </li>
              ))}
            </ul>
          ))}
      </section>

      <section>
        <h2>View</h2>
        <div className="seg">
          <button className={viewMode === 'uses' ? 'on' : ''} onClick={() => setViewMode('uses')}>Uses</button>
          <button className={viewMode === 'score' ? 'on' : ''} onClick={() => setViewMode('score')}>Walk score</button>
          <select value={viewMode !== 'uses' && viewMode !== 'score' ? viewMode : ''} onChange={(e) => e.target.value && setViewMode(e.target.value)} className={viewMode !== 'uses' && viewMode !== 'score' ? 'on' : ''}>
            <option value="">Minutes to…</option>
            {CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORIES[k].label}</option>)}
          </select>
        </div>
        {viewMode === 'score' && <Legend render={(v) => scoreColor(v)} stops={[[0], [50], [100]]} labels={['0', '50', '100']} caption="Walk score of each home (grey = non-residential)" />}
        {viewMode !== 'uses' && viewMode !== 'score' && <Legend render={(v) => minutesColor(v)} stops={[[0], [15], [30]]} labels={['0 min', '15', '30+']} caption={`Walking minutes to the nearest ${CATEGORIES[viewMode].label.toLowerCase()}`} />}
      </section>

      <section>
        <h2>Layers</h2>
        <label className="check"><input type="checkbox" checked={layers.satellite} onChange={(e) => setLayers({ ...layers, satellite: e.target.checked })} /> Satellite imagery</label>
        <label className="check"><input type="checkbox" checked={layers.tilt} onChange={(e) => setLayers({ ...layers, tilt: e.target.checked })} /> 3D tilt</label>
        <label className="check"><input type="checkbox" checked={layers.streets} onChange={(e) => setLayers({ ...layers, streets: e.target.checked })} /> Walking network</label>
        <label className="check"><input type="checkbox" checked={layers.labels} onChange={(e) => setLayers({ ...layers, labels: e.target.checked })} /> Names</label>
        <label>Building opacity {Math.round(layers.opacity * 100)}%
          <input type="range" min="0.15" max="1" step="0.05" value={layers.opacity} onChange={(e) => setLayers({ ...layers, opacity: Number(e.target.value) })} />
        </label>
      </section>

      <section>
        <h2>Uses</h2>
        <ul className="legend-list">
          {USE_KEYS.filter((k) => counts[k]).map((k) => (
            <li key={k} onClick={() => { setBrushUse(k); setTool('paint'); }} className={tool === 'paint' && brushUse === k ? 'on' : ''} title="Click to paint this use">
              <span className="swatch" style={{ background: USES[k].color }} />
              <span>{USES[k].label}</span>
              <span className="count">{counts[k]}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

function Legend({ render, stops, labels, caption }) {
  const grad = `linear-gradient(90deg, ${stops.map(([v], i) => `${render(v)} ${(i / (stops.length - 1)) * 100}%`).join(', ')})`;
  return (
    <div className="legend">
      <div className="legend-bar" style={{ background: grad }} />
      <div className="legend-labels">{labels.map((l) => <span key={l}>{l}</span>)}</div>
      <div className="small muted">{caption}</div>
    </div>
  );
}
