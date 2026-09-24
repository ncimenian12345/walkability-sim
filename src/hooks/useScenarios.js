import { useCallback, useEffect, useMemo, useState } from 'react';

const KEY = 'walkability-sim:scenarios:v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

/**
 * Saved scenarios live in localStorage: {id, name, savedAt, townKey, scenario, summary}.
 * `scenario` is the {mods, added} diff; `summary` is the metric snapshot at save time.
 * Only scenarios for the town currently loaded are listed.
 */
export function useScenarios(townKey) {
  const [all, setAll] = useState(load);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota / private mode */ }
  }, [all]);

  const scenarios = useMemo(() => all.filter((s) => (s.townKey || 'generated') === townKey), [all, townKey]);

  const save = useCallback((name, scenario, summary) => {
    const s = { id: `sc_${Date.now().toString(36)}`, name: name || `Scenario ${scenarios.length + 1}`, savedAt: new Date().toISOString(), townKey, scenario, summary };
    setAll((prev) => [...prev, s]);
    return s;
  }, [scenarios.length, townKey]);

  const remove = useCallback((id) => setAll((prev) => prev.filter((s) => s.id !== id)), []);
  const rename = useCallback((id, name) => setAll((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s))), []);
  const importAll = useCallback((list) => setAll((prev) => [
    ...prev,
    ...list.map((s) => ({ ...s, townKey: s.townKey || townKey, id: `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` })),
  ]), [townKey]);

  return { scenarios, save, remove, rename, importAll };
}
