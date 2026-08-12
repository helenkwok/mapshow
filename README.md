# Mapshow

Mapshow is an open-data browser experiment for turning global map data into a lightweight 3D world.

The project deliberately separates **map delivery** from **game/world generation**:

- [OpenFreeMap](https://openfreemap.org/) provides preprocessed OpenStreetMap-derived vector tiles.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) renders the global map and DEM terrain in the browser.
- [AWS Terrain Tiles / Tilezen](https://registry.opendata.aws/terrain-tiles/) provides the default real elevation source in Terrarium format.
- Mapshow discovers the OpenMapTiles `building` layer and progressively enriches it instead of treating the source style's extrusion as the final building representation.
- Three.js is used only for close-range game/world geometry that MapLibre's normal style layers are not intended to generate.
- Game-road geometry, collision and broader world streaming remain separate layers of the architecture.

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

The prototype provides:

- OpenFreeMap Liberty style with no API key;
- **real 3D DEM terrain** from AWS Terrain Tiles / Tilezen;
- MapLibre `raster-dem` decoding using Terrarium encoding;
- terrain hillshade and a terrain on/off control;
- terrain-aware grounding of streamed Three.js building detail via `queryTerrainElevation()`;
- pitched 3D map navigation;
- automatic discovery of OpenMapTiles building data;
- LOD1 building massing at medium zoom;
- LOD2 procedural façade rendering at close zoom;
- separate ground/storefront, façade-body and roof-cap bands;
- generated brick, masonry and glass façade/window patterns;
- height-based deterministic façade-family selection;
- automatic multi-building LOD3 geometry generated from real vector-tile footprints;
- batched Three.js window panes and frames on usable façade edges;
- generated entrances and roof geometry;
- hipped roofs for simple convex low-rise footprints;
- flat-roof + parapet geometry as the general fallback;
- nearest-first LOD3 selection within a bounded camera radius;
- cached building groups that survive unchanged refreshes;
- GPU-buffer disposal when buildings leave the active detail set;
- building visibility control and feature/profile/terrain inspection;
- presets for Adelaide, Hong Kong, Manhattan, and Tokyo;
- responsive desktop/mobile controls.

## Terrain pipeline

```text
AWS Open Data elevation-tiles-prod
          │
          │ Terrarium PNG (z0–15)
          ▼
MapLibre raster-dem source
          │
          ├─ 3D terrain mesh
          ├─ hillshade
          └─ queryTerrainElevation()
                    │
                    ▼
          LOD3 Three.js building ground Z
```

The terrain source is behind `src/map/terrain.ts`, so a future Copernicus GLO-30 pipeline or higher-resolution regional DEM can replace the default source without changing the rest of the application. The current AWS dataset is a multi-source global terrain product; it is not simply Copernicus GLO-30.

## Building LOD strategy

```text
LOD1  OpenMapTiles footprint → simple extrusion
LOD2  footprint + height     → segmented patterned façade
LOD3  nearby footprints      → metric window/door/roof geometry in Three.js
```

LOD3 currently activates at zoom 16.1 or closer. It considers rendered buildings within 260 m of the camera center, sorts them nearest-first and keeps at most 24 buildings active. Each building is capped at 96 generated windows, with per-edge and floor caps as an additional geometry guardrail.

The LOD3 renderer retains unchanged building groups between refreshes. Buildings that leave the desired set have their `BufferGeometry` disposed immediately; new buildings are generated incrementally. When terrain is enabled, active building groups are re-anchored as DEM samples become available, avoiding the floating-building problem common to custom 3D layers over terrain.

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

1. **Map foundation** — OpenFreeMap + MapLibre + basic 3D building extrusion. *(complete)*
2. **Procedural building LOD2** — façade segmentation, generated window/material patterns, façade families and roof caps. *(complete)*
3. **Procedural building LOD3 foundation** — real window/door/roof geometry through a Three.js custom layer. *(complete)*
4. **LOD3 streaming** — bounded, nearest-first multi-building generation with caching and disposal. *(complete)*
5. **Real DEM terrain** — pluggable raster-DEM provider, hillshade, terrain control and terrain-aware LOD3 anchoring. *(current)*
6. **Game-road schema** — generate a separate Planetiler profile that retains stable OSM IDs and driving attributes such as `lanes`, `maxspeed`, `width`, `surface`, `smoothness`, `oneway`, `bridge`, `tunnel`, and `layer`.
7. **Terrain refinement** — optional Copernicus GLO-30/self-hosted pipeline plus higher-resolution regional DEMs where licensing permits.
8. **World streaming** — worker-based decoding, tile-edge stitching, local/floating origin, memory budgets and near-player collision generation.
9. **Driving layer** — robust road surfaces, intersections, bridge/tunnel separation and vehicle physics.

## Data and attribution

The Apache-2.0 licence in this repository applies to Mapshow's own source code. It does not relicense third-party map data, elevation data, styles, fonts, libraries or services. See [`THIRD_PARTY.md`](THIRD_PARTY.md).
