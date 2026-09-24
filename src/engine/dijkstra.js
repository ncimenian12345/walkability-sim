// Multi-source Dijkstra with a binary heap. Returns the walking distance (m)
// from every node to the nearest source. `cutoff` stops the search early —
// anything beyond it is reported as Infinity.

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      k[0] = lastK; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return [topK, topV];
  }
}

/**
 * @param graph  from buildGraph()
 * @param sources array of [nodeId, initialDistance]
 * @param cutoff  max distance to explore (m)
 * @returns Float64Array of distances per node
 */
export function multiSourceDijkstra(graph, sources, cutoff = Infinity) {
  const n = graph.size;
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (const [node, d0] of sources) {
    if (d0 < dist[node]) { dist[node] = d0; heap.push(d0, node); }
  }
  const adj = graph.adj;
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (d > cutoff) break;
    const edges = adj[u];
    for (let i = 0; i < edges.length; i++) {
      const [v, w] = edges[i];
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
    }
  }
  return dist;
}
