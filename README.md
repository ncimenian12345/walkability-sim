# Walkability Sim

**Live:** https://ncimenian12345.github.io/walkability-sim/

A Google-Earth-style 3D town simulator for testing walkability and sustainability.
Every building has a *use* (housing, grocery, café, school, park…). Swap uses, add or
remove amenities, change building heights — and watch the walkability metrics update
live. Save layouts as scenarios and compare them side by side.

Built with React + Vite + [MapLibre GL](https://maplibre.org/). Runs entirely in the
browser; no API keys.

## Quick start

```bash
npm install
npm run dev          # opens http://localhost:5173
```

On first launch the app downloads **real downtown Kennebunk** in your browser and caches it:

* **Building footprints** from FEMA's *USA Structures* dataset (every US structure over 40 m²,
  traced from imagery, with occupancy type, height and a population estimate). OpenStreetMap
  only has outlines for a fraction of Kennebunk's buildings, so FEMA fills the gaps.
* **Streets, footpaths, businesses and place names** from OpenStreetMap, laid on top of those
  footprints (a café or pharmacy mapped in OSM becomes that building's use).

Because both sources are traced from aerial imagery, the buildings sit on the satellite layer.

To load somewhere else, type a town in **Town → Search**, or pan/zoom the map and press
**Load real buildings for this view** (up to ~30 km² at a time). The command-line version
writes the same data to `public/data/town.json`:

```bash
npm run fetch-town                                   # downtown Kennebunk
npm run fetch-town -- "Kennebunkport, Maine" --radius 1500
```

**Data gaps are normal.** OpenStreetMap coverage of small-town businesses is patchy (for
Kennebunk it doesn't list a café or pharmacy downtown), so check the *Uses* view against the
satellite image and correct buildings with the edit tools. That's also a quick baseline step
before testing scenarios.

## How to use it

| Action | How |
|---|---|
| Inspect / edit a building | **Select** tool (V), click it. Change name, use, storeys; rotate, resize, duplicate, remove. |
| Move a building | Select it, then drag it on the map. |
| Change many buildings | **Paint** tool (P) — or click a swatch in the *Uses* legend — then click buildings. |
| Add a building | **Drop building** (D): click to place a box of the chosen use and size, aligned to the nearest street. **Draw building** (B): click corners, then click the first corner / double-click / Enter. |
| Add a footpath or cut-through | **Add footpath** (F): click points; they snap to streets (orange dot) so the path joins the walking network. Double-click or Enter to finish. |
| Edit or remove a street | Select it to change its type or sidewalk, or use **Remove** (X). |
| Remove anything | **Remove** tool, or select it and press Delete. Removed items stay as red dashed outlines. |
| Undo / redo | ⌘Z / ⇧⌘Z, or the arrows next to *Tools*. The **Changes** list shows every edit; ↺ reverts one. |
| Heatmaps | **View → Walk score** or **Minutes to…** a category. |
| Save & compare | Name the layout and **Save**; tick saved scenarios to compare. Export/Import JSON to share. |
| Satellite / opacity / tilt | **Layers**. Lower building opacity to check footprints against the imagery. |

## What the numbers mean

* **Walk score (resident-weighted)** — a Walk-Score-style 0–100 index. For each home we take
  the network walking distance to the nearest provider of each category (grocery, café,
  school, park, transit…), apply a distance decay (full credit ≤ 400 m, ~12 % at 1.6 km,
  0 at 2.4 km) and a category weight (grocery counts most). The town figure is the average
  over homes weighted by estimated residents.
* **15-minute residents** — share of estimated residents whose home has *every essential*
  (grocery, pharmacy, healthcare, school, park, transit) within a 15-minute walk
  (1,200 m at 80 m/min) along the street network.
* **Residents within 15 min of…** — the same test per category. "×3" = three providers in town.
* **Residents** come from FEMA's per-building population estimate; for buildings you add or
  change they're estimated from footprint × storeys (≈1 person per 60 m² for houses, 35 m² for
  apartments; mixed-use counts upper floors only).

All routing is on the real pedestrian network (streets, footways, paths), with a mild
comfort penalty for walking along busier roads or roads OSM tags as having no sidewalk.
The engine (`src/engine/`) is plain JavaScript with no dependencies and has tests:

```bash
npm test
```

## Extending it

* **Add a use** — edit `src/data/uses.js` (colour, category, default storeys, residents/m²).
  Map OSM tags to it in `scripts/fetch-town.mjs → useFromTags()`.
* **Change the walkability model** — `src/engine/metrics.js` (decay curve, weights,
  essentials, walking speed) and `src/engine/graph.js` (street-type penalties).
* **Emissions / trips** — `metrics.summary` already has per-home minutes to every category;
  a trip-substitution model (walk vs. drive by distance) is a natural next layer.

## Project layout

```
public/data/town.json     fallback town data (stand-in, or a fetch-town extract)
src/data/osm.js           OpenStreetMap download + conversion
src/data/structures.js    FEMA USA Structures footprints + merge
src/engine/scenario.js    edits as a diff (mods / added) against the base town
scripts/fetch-town.mjs    same loader from the command line
scripts/generate-town.mjs procedural stand-in → town.json
src/data/uses.js          use catalog + categories + weights
src/data/generateTown.js  procedural town generator
src/engine/               graph, Dijkstra, metrics (framework-free, tested)
src/components/MapView    MapLibre 3D map
src/components/Sidebar    view modes, editing, legend, layers
src/components/MetricsPanel  KPIs, coverage bars, scenarios & comparison
```

Map tiles: [OpenFreeMap](https://openfreemap.org) (© OpenStreetMap contributors);
satellite imagery © Esri; building footprints: FEMA USA Structures (public domain).

## Deploying

Every push to `main` runs the tests, builds the site and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). Scenarios and the downloaded town are stored in each
visitor's own browser; use **Export JSON** / **Import JSON** to share a scenario.
