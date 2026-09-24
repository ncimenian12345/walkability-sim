import { useRef } from 'react';
import { CATEGORIES, CATEGORY_KEYS } from '../data/uses.js';
import { scoreColor } from '../colors.js';
import { changeCount, normalizeScenario } from '../engine/scenario.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const delta = (cur, base, fmt = (v) => v, invert = false) => {
  if (base === undefined || base === null) return null;
  const d = cur - base;
  if (Math.abs(d) < 1e-9) return <span className="delta zero">–</span>;
  const good = invert ? d < 0 : d > 0;
  return <span className={`delta ${good ? 'up' : 'down'}`}>{d > 0 ? '+' : ''}{fmt(d)}</span>;
};

export default function MetricsPanel({
  metrics, baseMetrics, editCount, scenarioName, setScenarioName, onSave, scenarios, onLoad, onDelete, onRename,
  compareIds, setCompareIds, onExport, onImport, onShowCategory, viewMode,
}) {
  const fileRef = useRef(null);
  if (!metrics) return <aside className="panel panel-right" />;
  const s = metrics.summary;
  const b = baseMetrics?.summary;
  const compared = scenarios.filter((sc) => compareIds.includes(sc.id));

  return (
    <aside className="panel panel-right">
      <section>
        <h2>Current scenario {editCount ? <span className="pill">{editCount} change{editCount === 1 ? '' : 's'}</span> : <span className="pill muted">baseline</span>}</h2>
        <div className="kpis">
          <div className="kpi">
            <div className="kpi-value" style={{ color: scoreColor(s.avgScore) }}>{s.avgScore}</div>
            <div className="kpi-label">Walk score <span className="muted">(resident‑weighted)</span> {delta(s.avgScore, b?.avgScore)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-value">{pct(s.fifteenMinShare)}</div>
            <div className="kpi-label">15‑minute residents {delta(s.fifteenMinShare, b?.fifteenMinShare, (d) => `${Math.round(d * 100)} pts`)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-value">{s.population.toLocaleString()}</div>
            <div className="kpi-label">est. residents {delta(s.population, b?.population, (d) => d.toLocaleString())}</div>
          </div>
          <div className="kpi">
            <div className="kpi-value">{s.amenityBuildings}</div>
            <div className="kpi-label">amenities {delta(s.amenityBuildings, b?.amenityBuildings)}</div>
          </div>
        </div>
        <p className="small muted">A "15‑minute resident" has every essential (*) within a 15‑minute walk on the street network (1,200 m at 80 m/min).</p>
      </section>

      <section>
        <h2>Residents within 15 min of…</h2>
        <div className="bars">
          {CATEGORY_KEYS.map((k) => {
            const c = s.coverage[k];
            const bc = b?.coverage[k];
            return (
              <div key={k} className={`bar-row ${viewMode === k ? 'hl' : ''}`} onClick={() => onShowCategory(k)} title="Show minutes to this on the map">
                <div className="bar-label">{CATEGORIES[k].label}{CATEGORIES[k].essential ? ' *' : ''} <span className="muted">×{c.providers}</span></div>
                <div className="bar-track">
                  {bc && <div className="bar-ghost" style={{ width: pct(bc.share) }} />}
                  <div className="bar-fill" style={{ width: pct(c.share), background: c.share >= 0.8 ? '#2e7d32' : c.share >= 0.5 ? '#f9a825' : '#c62828' }} />
                </div>
                <div className="bar-value">{pct(c.share)} {delta(c.share, bc?.share, (d) => `${Math.round(d * 100)}`)}</div>
              </div>
            );
          })}
        </div>
        {b && editCount > 0 && <p className="small muted">Thin grey bar = baseline. Click a row to see it on the map.</p>}
      </section>

      <section>
        <h2>Scenarios</h2>
        <div className="save-row">
          <input placeholder="Name this layout…" value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSave()} />
          <button className="primary" onClick={onSave}>Save</button>
        </div>
        {scenarios.length === 0 && <p className="small muted">Save the current layout to compare it against future changes. Scenarios are kept in this browser.</p>}
        <ul className="scenario-list">
          {scenarios.map((sc) => (
            <li key={sc.id}>
              <label className="check"><input type="checkbox" checked={compareIds.includes(sc.id)} onChange={(e) => setCompareIds(e.target.checked ? [...compareIds, sc.id] : compareIds.filter((x) => x !== sc.id))} /></label>
              <input className="inline-name" value={sc.name} onChange={(e) => onRename(sc.id, e.target.value)} />
              <span className="muted small">{changeCount(normalizeScenario(sc))} changes · score {sc.summary.avgScore}{sc.route ? ' · 🚶 route' : ''}</span>
              <button className="link" onClick={() => onLoad(sc)}>Load</button>
              <button className="link danger" onClick={() => onDelete(sc.id)}>✕</button>
            </li>
          ))}
        </ul>
        {compared.length > 0 && (
          <div className="compare">
            <table>
              <thead>
                <tr><th></th><th>Now</th>{compared.map((sc) => <th key={sc.id}>{sc.name}</th>)}</tr>
              </thead>
              <tbody>
                <tr><td>Walk score</td><td><b>{s.avgScore}</b></td>{compared.map((sc) => <td key={sc.id}>{sc.summary.avgScore} {delta(s.avgScore, sc.summary.avgScore)}</td>)}</tr>
                <tr><td>15‑min residents</td><td><b>{pct(s.fifteenMinShare)}</b></td>{compared.map((sc) => <td key={sc.id}>{pct(sc.summary.fifteenMinShare)} {delta(s.fifteenMinShare, sc.summary.fifteenMinShare, (d) => `${Math.round(d * 100)}`)}</td>)}</tr>
                <tr><td>Residents</td><td><b>{s.population.toLocaleString()}</b></td>{compared.map((sc) => <td key={sc.id}>{sc.summary.population.toLocaleString()}</td>)}</tr>
                <tr><td>Amenities</td><td><b>{s.amenityBuildings}</b></td>{compared.map((sc) => <td key={sc.id}>{sc.summary.amenityBuildings}</td>)}</tr>
                {CATEGORY_KEYS.map((k) => (
                  <tr key={k} className="sub"><td>{CATEGORIES[k].label}</td><td>{pct(s.coverage[k].share)}</td>{compared.map((sc) => <td key={sc.id}>{pct(sc.summary.coverage[k].share)} {delta(s.coverage[k].share, sc.summary.coverage[k].share, (d) => `${Math.round(d * 100)}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Deltas are "Now" minus the saved scenario.</p>
          </div>
        )}
        <div className="row-between small">
          <button className="link" onClick={onExport}>Export JSON</button>
          <button className="link" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
        </div>
      </section>
    </aside>
  );
}
