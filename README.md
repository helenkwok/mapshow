# Mapshow

Mapshow is an open-data browser experiment for turning global map data into a lightweight 3D world.

The project deliberately separates **map delivery** from **game/world generation**:

- [OpenFreeMap](https://openfreemap.org/) provides preprocessed OpenStreetMap-derived vector tiles for the visual basemap.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) renders the global map and DEM terrain in the browser.
- [AWS Terrain Tiles / Tilezen](https://registry.opendata.aws/terrain-tiles/) provides the default real elevation source in Terrarium format.
- Mapshow discovers the OpenMapTiles `building` layer and progressively enriches it instead of treating the source style's extrusion as the final building representation.
- Three.js is used only for close-range game/world geometry that MapLibre's normal style layers are not intended to generate.
- `road-schema/` generates a separate simulation-oriented OSM road tileset rather than treating visual cartographic road tiles as physics-ready data.

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
- real 3D DEM terrain from AWS Terrain Tiles / Tilezen;
- MapLibre `raster-dem` decoding using Terrarium encoding;
- terrain hillshade and a terrain on/off control;
- terrain-aware grounding of streamed Three.js building detail;
- LOD1 building massing, LOD2 procedural façade patterns, and bounded multi-building LOD3 geometry;
- generated Three.js windows, frames, entrances and roofs;
- cached building groups with GPU-buffer disposal as buildings leave the detail set;
- **game-road schema v2**, generated with Planetiler after splitting OSM roads at shared intersection nodes;
- stable `segment_id` + parent `osm_id`, width, lanes, surface, access, direction and grade-separation metadata;
- browser-side tile-fragment grouping/stitching and a directed local road graph;
- **terrain-aware metric carriageway meshes** generated from `width_m` and active road centerlines;
- junction pads at shared graph nodes;
- bounded road streaming at 650 m / 240 active segments;
- road-surface enable/disable control when a dedicated game-road TileJSON is configured;
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
          ┌─────────┴─────────┐
          ▼                   ▼
  LOD3 building Z       road-surface Z
```

The terrain source is behind `src/map/terrain.ts`, so a future Copernicus GLO-30 pipeline or higher-resolution regional DEM can replace the default source without changing the rest of the application. The current AWS dataset is a multi-source global terrain product; it is not simply Copernicus GLO-30.

## Building LOD strategy

```text
LOD1  OpenMapTiles footprint → simple extrusion
LOD2  footprint + height     → segmented patterned façade
LOD3  nearby footprints      → metric window/door/roof geometry in Three.js
```

LOD3 activates at zoom 16.1 or closer. It considers rendered buildings within 260 m of the camera center, sorts them nearest-first and keeps at most 24 buildings active. Each building is capped at 96 generated windows, with per-edge and floor caps as additional geometry guardrails.

## Game-road pipeline

Visual OpenFreeMap roads remain cartographic context. Mapshow's simulation-road path is separate:

```text
OpenStreetMap PBF
      │
      ▼
Planetiler MapshowRoadProfile
      │
      ├─ split ways at shared OSM junction nodes
      └─ retain driving/vertical metadata
      │
      ▼
 game_road MVT schema v2
      │
      ▼
MapLibre vector source
      │
      ▼
road-world assembler
      ├─ group clipped duplicates by segment_id
      ├─ stitch safe overlaps
      ├─ connect first_node / last_node graph nodes
      └─ apply one-way direction
      │
      ▼
Three.js road-surface layer
      ├─ densify centerlines
      ├─ sample DEM
      ├─ offset by width_m / 2
      ├─ fill shared junctions
      └─ stream/dispose bounded local geometry
```

The generator is in [`road-schema/`](road-schema/) and the contract/runtime details are in [`docs/GAME_ROADS.md`](docs/GAME_ROADS.md). Compile/test it with Java 21:

```bash
mvn -B -f road-schema/pom.xml verify
```

Serve the generated MBTiles through a vector-tile server and provide its TileJSON:

```bash
VITE_GAME_ROADS_TILEJSON=http://localhost:8080/data/game-roads.json
VITE_GAME_ROADS_DEBUG=false
npm run dev
```

When `VITE_GAME_ROADS_TILEJSON` is absent, Mapshow disables the road-surface control instead of substituting the OpenFreeMap cartographic transportation layer.

Bridge/tunnel vertical placement is currently a **visual heuristic**, not surveyed engineering geometry. OSM `bridge`, `tunnel`, and `layer` keep crossings separate, while a later refinement stage will smooth grades, model approaches and consume explicit elevation data where available.

## Architecture direction

```text
OpenStreetMap planet data
    ├─ OpenFreeMap/OpenMapTiles tiles ──> visual basemap + contextual buildings
    └─ Mapshow game-road tiles ─────────> topology + simulation road attributes

DEM elevation tiles ───────────────────> terrain surface

                         local world streaming
                              │
                  ┌───────────┴───────────┐
                  │                       │
           visual geometry       collision / physics
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the staged plan.

## Roadmap

1. **Map foundation** — OpenFreeMap + MapLibre + basic 3D building extrusion. *(complete)*
2. **Procedural building LOD2** — façade segmentation, generated window/material patterns, façade families and roof caps. *(complete)*
3. **Procedural building LOD3 foundation** — real window/door/roof geometry through a Three.js custom layer. *(complete)*
4. **LOD3 streaming** — bounded, nearest-first multi-building generation with caching and disposal. *(complete)*
5. **Real DEM terrain** — pluggable raster-DEM provider, hillshade, terrain control and terrain-aware LOD3 anchoring. *(complete)*
6. **Game-road schema** — dedicated Planetiler profile and browser adapter. *(complete)*
7. **Road graph + surfaces** — OSM-intersection splitting, local directed graph, DEM-aligned carriageway strips and junction pads. *(current)*
8. **Road refinement** — proper intersection polygons, lane centerlines, grade smoothing, bridge/tunnel approaches and turn restrictions.
9. **Terrain refinement** — optional Copernicus GLO-30/self-hosted pipeline plus higher-resolution regional DEMs where licensing permits.
10. **World streaming/physics** — workers, floating origin, collision budgets and vehicle physics.

## Data and attribution

The Apache-2.0 licence in this repository applies to Mapshow's own source code. It does not relicense third-party map data, elevation data, styles, fonts, libraries or services. See [`THIRD_PARTY.md`](THIRD_PARTY.md).
