// Keeps the most recently loaded town in IndexedDB so a real OSM extract only
// has to be downloaded once. Every call fails soft (private windows, blocked storage).

const DB = 'walkability-sim';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function loadCachedTown() {
  try { return (await tx('readonly', (s) => s.get('town'))) || null; } catch { return null; }
}
export async function cacheTown(town) {
  try { await tx('readwrite', (s) => s.put(town, 'town')); } catch { /* ignore */ }
}
export async function clearCachedTown() {
  try { await tx('readwrite', (s) => s.delete('town')); } catch { /* ignore */ }
}
