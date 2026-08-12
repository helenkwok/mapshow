# Mapshow

Mapshow is an open-data browser experiment for turning global map data into a lightweight 3D world.

The first milestone deliberately separates **map delivery** from **game/world generation**:

- [OpenFreeMap](https://openfreemap.org/) provides preprocessed OpenStreetMap-derived vector tiles.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) renders the global map in the browser.
- Mapshow discovers the OpenMapTiles `building` layer and enables or creates 3D extrusion from `render_height` / `render_min_height`.
- The building code lives behind a small adapter so richer procedural geometry can replace basic extrusion later.

This repository does **not** contain source code or assets copied from MGame or Hop.Earth. Those projects are architectural references for features we can implement independently.

## Run locally

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```

## Current prototype

The initial prototype provides:

- OpenFreeMap Liberty style with no API key;
- pitched 3D map navigation;
- automatic discovery of OpenMapTiles building data;
- 3D building visibility control;
- building-property inspection by clicking rendered geometry;
- presets for Adelaide, Hong Kong, Manhattan, and Tokyo;
- responsive desktop/mobile controls.

## Architecture direction

Mapshow should not treat cartographic tiles as physics-ready world geometry. The intended pipeline is:

```text
OpenStreetMap planet data
    ├─ OpenFreeMap/OpenMapTiles tiles ──> visual basemap + contextual buildings
    └─ custom game-road tiles ─────────> lanes/speed/width/surface/topology

DEM elevation tiles ───────────────────> terrain surface

                         browser workers
                              │
                 stitch / drape / generate LOD
                     ┌────────┴────────┐
                     │                 │
              visual scene       collision scene
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the staged plan.

## Roadmap

1. **Map foundation** — OpenFreeMap + MapLibre + basic 3D building extrusion. *(current)*
2. **Game-road schema** — generate a separate Planetiler profile that retains stable OSM IDs and driving attributes such as `lanes`, `maxspeed`, `width`, `surface`, `smoothness`, `oneway`, `bridge`, `tunnel`, and `layer`.
3. **DEM terrain** — add a pluggable elevation-tile provider and terrain mesh generation.
4. **Procedural buildings** — move beyond simple extrusion with façade segmentation, repeated window bays, entrances/socles, roof generators, materials, apparent interiors, and optional custom models. MGame demonstrates that this is feasible without photogrammetry; Mapshow will implement its own system.
5. **World streaming** — worker-based decoding, tile-edge stitching, LOD, local/floating origin, memory budgets, and near-player collision generation.
6. **Driving layer** — robust road surfaces, intersections, bridge/tunnel separation and vehicle physics.

## Data and attribution

The Apache-2.0 licence in this repository applies to Mapshow's own source code. It does not relicense third-party map data, styles, fonts, libraries or services. See [`THIRD_PARTY.md`](THIRD_PARTY.md).
