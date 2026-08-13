# Mapshow

Mapshow is an open-data browser experiment for turning global map data into a lightweight 3D world.

The project deliberately separates **map delivery** from **game/world generation**:

- [OpenFreeMap](https://openfreemap.org/) provides preprocessed OpenStreetMap-derived vector tiles for the visual basemap.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) renders the global map and DEM terrain in the browser.
- [AWS Terrain Tiles / Tilezen](https://registry.opendata.aws/terrain-tiles/) provides the default real elevation source in Terrarium format.
- Mapshow progressively enriches OpenMapTiles building footprints instead of treating simple extrusion as the final building representation.
- Three.js is used for close-range world geometry that normal map style layers are not intended to generate.
- `road-schema/` generates a separate simulation-oriented OSM road tileset rather than treating visual cartographic roads as physics-ready data.

This repository does **not** contain source code or assets copied from MGame or Hop.Earth. Those projects are architectural references for features implemented independently here.

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

The prototype now includes real DEM terrain, bounded procedural building LODs, a dedicated topology-aware `game_road` tileset, and a local road-world renderer. Road ways are split at shared OSM junction nodes in Planetiler, grouped/stitched after MVT clipping in the browser, converted into a directed graph, and rendered as metric-width Three.js carriageways.

The road layer also provides:

- smoothed terrain-following elevation profiles instead of raw DEM-to-vertex draping;
- eased bridge/tunnel transitions at mixed vertical-mode endpoints;
- approach-shaped intersection polygons built from real incident-road headings and widths;
- directional lane counts from `lanes`, `lanes:forward`, and `lanes:backward` when available;
- inferred physical lane counts only when explicit lane counts are absent;
- lane centerline geometry with explicit left- or right-hand traffic placement;
- OSM `turn:lanes*` semantics applied per directed lane;
- simple unconditional via-node `no_*` / `only_*` restriction-relation enforcement;
- conditional and via-way restrictions preserved but reported as unenforced rather than guessed;
- a legal lane-to-lane connection graph separated from raw geometric candidates;
- renderer-independent simplified collision triangle bodies for road segments and intersections;
- preset-aware traffic side: Adelaide, Hong Kong, and Tokyo use left-hand traffic; Manhattan uses right-hand traffic;
- a manual traffic-side toggle for arbitrary locations;
- bounded road streaming at 650 m / 240 active topology segments.

Access restrictions such as private/no-access roads are retained as routing metadata and do not make the physical road disappear from the world geometry.

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
  LOD3 building Z       road profile sampler
                              │
                       smooth / grade-limit
                              │
                    carriageways + junctions
```

The terrain provider is isolated in `src/map/terrain.ts`, so Copernicus GLO-30 or higher-resolution regional data can later replace/override the current source without changing building or road contracts.

## Building LOD strategy

```text
LOD1  OpenMapTiles footprint → simple extrusion
LOD2  footprint + height     → segmented patterned façade
LOD3  nearby footprints      → metric window/door/roof geometry in Three.js
```

LOD3 activates at zoom 16.1 or closer, considers buildings within 260 m, and keeps at most 24 detailed buildings active with explicit per-building geometry caps and GPU disposal.

## Game-road pipeline

```text
OpenStreetMap PBF
      │
      ▼
Planetiler MapshowRoadProfile
      ├─ split at shared OSM junction nodes
      ├─ retain identity / lanes / width / access / vertical metadata
      ├─ retain turn:lanes* / change:lanes*
      └─ attach from-way restriction relation metadata
      │
      ▼
 game_road MVT schema v3
      │
      ▼
road-world assembler
      ├─ group by segment_id
      ├─ direction-preserving tile-fragment stitching
      ├─ first_node / last_node topology
      └─ directed road graph
      │
      ▼
lane policy
      ├─ left/right traffic placement
      ├─ directed lane centerlines
      ├─ geometric candidate connections
      ├─ turn:lanes filtering
      └─ simple via-node restriction filtering
      │
      ▼
road profile + surface generation
      ├─ ~8 m DEM samples
      ├─ elevation smoothing / grade limiting
      ├─ bridge/tunnel approach easing
      ├─ metric carriageway strips
      ├─ approach-shaped intersection polygons
      └─ simplified collision triangle bodies
```

The generator is in [`road-schema/`](road-schema/) and details are in [`docs/GAME_ROADS.md`](docs/GAME_ROADS.md). Compile/test it with Java 21:

```bash
mvn -B -f road-schema/pom.xml verify
```

Serve the generated MBTiles through a vector-tile server and provide its TileJSON:

```bash
VITE_GAME_ROADS_TILEJSON=http://localhost:8080/data/game-roads.json
VITE_GAME_ROADS_DEBUG=false
npm run dev
```

Without `VITE_GAME_ROADS_TILEJSON`, Mapshow disables simulation road surfaces rather than substituting OpenFreeMap's cartographic transportation layer.

## Scope boundary

Mapshow now separates **candidate topology**, **legal lane connectivity**, and **collision geometry**. Simple via-node restrictions and turn-lane indications are enforced for the generic car policy, while conditional/via-way restrictions, signal phases, `change:lanes*`, and jurisdiction-specific rules remain explicit future policy layers.

The collision world is deliberately physics-engine agnostic. It exposes coarse road/intersection triangle bodies but does not yet choose Rapier, Jolt, Bullet, or another vehicle-physics stack.

Bridge and tunnel vertical positions remain improved visual/world approximations, not engineering survey geometry.

## Roadmap

1. Map foundation — complete.
2. Procedural building LOD2 — complete.
3. Procedural building LOD3 — complete.
4. Bounded building streaming — complete.
5. Real DEM terrain — complete.
6. Dedicated game-road schema — complete.
7. Topology-aware road graph and carriageway surfaces — complete.
8. Road refinement: intersection polygons, lane centerlines/connectivity, grade smoothing and traffic side — complete.
9. **Turn policy + simplified collision bodies — current.**
10. Lane-change/signal policy, routing interface and floating-origin physics adapter.
11. Vehicle controller, suspension/tire model and driving simulation.

## Data and attribution

The Apache-2.0 licence in this repository applies to Mapshow's own source code. It does not relicense third-party map data, elevation data, styles, fonts, libraries or services. See [`THIRD_PARTY.md`](THIRD_PARTY.md).
