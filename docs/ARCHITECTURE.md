# Architecture

Mapshow is built as replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap into immutable tiles rather than query Overpass while the player moves.
2. **Do not confuse cartography with simulation.** OpenMapTiles is visual context; simulation road data has a separate schema.
3. **Keep terrain independent from vector maps.** Elevation has its own provider interface.
4. **Generate detail near the viewer.** Expensive geometry and collision are bounded near the camera/player.
5. **Bound every expensive layer.** Dense cities degrade to cheaper LODs rather than growing GPU allocations without limit.
6. **Preserve provenance and identity.** OSM feature IDs and data licences survive preprocessing wherever the world layer needs traceability.

## Data planes

```text
                        OpenStreetMap
                         /          \
                        /            \
             OpenFreeMap MVT      Mapshow game-road MVT
                 │                       │
                 │ visual               │ simulation
                 ▼                       ▼
          MapLibre basemap       road decoder / graph
                 │                       │
                 ├──────────────┐        │
                 │              │        │
AWS/Tilezen DEM ─┤              ▼        ▼
                 │       building LODs  road surfaces
                 ▼              │        │
          MapLibre terrain      └───┬────┘
                                    ▼
                             local world frame
                                    │
                              Three.js/physics
```

The visual and simulation road products are intentionally independent. A future switch of visual map style must not change driving geometry, and a change to the road-physics schema must not require rebuilding the visual OpenFreeMap style.

## Terrain

`src/map/terrain.ts` owns the elevation provider boundary. The first provider is the public AWS Open Data `elevation-tiles-prod` Terrarium dataset. MapLibre decodes the raster DEM, renders terrain/hillshade, and exposes `queryTerrainElevation()`.

Custom Three.js building geometry samples DEM elevation and anchors its Mercator origin to the sampled ground Z. Existing cached building groups can update their terrain Z without rebuilding their façade geometry.

The provider boundary can later be backed by Copernicus GLO-30 or higher-resolution regional LiDAR/DTM sources without changing building or road contracts.

## Building LODs

OpenMapTiles building features feed three progressively more expensive representations:

```text
footprint + tags
      │
      ├─ LOD1: simple MapLibre massing
      ├─ LOD2: segmented patterned façade
      └─ LOD3: bounded Three.js geometry
             ├─ windows + frames
             ├─ entrance
             └─ generated roof
```

Current LOD3 budget:

```text
minimum zoom              16.1
camera detail radius      260 m
maximum active buildings  24
maximum windows/building  96
maximum bays/edge          8
maximum detailed floors   10
```

`src/map/building-feature.ts` extracts/deduplicates real vector-tile footprints and carries sampled terrain height. `src/map/building-detail-layer.ts` owns Three.js geometry, keyed caching, terrain anchoring and disposal. `src/main.ts` owns the current streaming policy.

## Game-road tile schema

`road-schema/` is now the simulation-road preprocessing boundary. It uses Planetiler v0.10.2 with Java 21 and emits a dedicated MVT layer named `game_road` from zoom 12 through 16.

The profile intentionally does **not** merge distinct OSM ways. Every feature retains the source `osm_id`, source-way endpoint node IDs and node count alongside its line geometry.

### Contract

The versioned machine-readable contract is `road-schema/schema.json`. Important groups are:

**Identity/topology**

- `schema_version`
- `osm_id`
- `first_node`, `last_node`, `node_count`

**Classification/dimensions**

- `highway`, `road_class`, `is_link`
- raw and parsed lane counts
- `width_raw`, `width_m`, `width_source`
- raw and parsed tagged speeds

**Driving/ride properties**

- `surface`, `surface_class`, `smoothness`, `tracktype`
- `oneway`
- `access`, `vehicle`, `motor_vehicle`
- `service`, `junction`

**Vertical separation**

- `bridge`
- `tunnel`
- `layer`
- `z_order` convenience hint

The generator keeps raw OSM fields alongside normalized fields. `speed_kmh` is emitted only for a parseable tagged maxspeed; jurisdiction-specific legal defaults are not invented. `width_m` may be estimated because a road mesh needs a physical width, and `width_source` records whether it came from an explicit tag, lane count or class fallback.

### Why the zoom range starts at 12

The road tiles are simulation input, not a replacement basemap. Generating only z12–16 keeps source geometry detail high while avoiding a second planet-scale low-zoom cartographic product that Mapshow does not need for driving.

Planetiler simplification is disabled in this profile and a tile buffer is retained so the browser can reconcile road geometry across tile edges before generating local surfaces.

### Browser adapter

`src/map/game-roads.ts` defines the TypeScript representation of `game_road`, validates required properties and can attach an independently hosted TileJSON source with:

```text
VITE_GAME_ROADS_TILEJSON=<tilejson-url>
VITE_GAME_ROADS_DEBUG=true   # optional validation overlay only
```

The debug line is not a driveable road surface.

### Topology boundary

The current MVT contract preserves source-way identity, endpoint node IDs and detailed line geometry, but it is not yet a complete routing/physics graph. An OSM way may contain shared intersection nodes internally, not only at its endpoints.

The next road stage must therefore:

1. decode a bounded set of nearby `game_road` tiles;
2. deduplicate features by `osm_id` and clipped geometry;
3. find/retain internal junctions by geometric intersection and/or a graph sidecar built directly from OSM node references;
4. split centerlines into graph segments;
5. stitch segments across MVT tile boundaries;
6. preserve `bridge`/`tunnel`/`layer` when deciding whether crossings actually intersect;
7. reconcile ground-road elevations with DEM while keeping bridges/tunnels on independent vertical paths;
8. generate local metric carriageway and collision meshes.

This is deliberately separate from routing policy: access restrictions and directional tags are preserved so routing/vehicle rules can be layered on later.

## Road/terrain interaction

Ground roads cannot simply be draped to every raw DEM sample. The world generator should eventually smooth a road corridor while respecting real hills, then blend the corridor back into terrain. Bridges and tunnels must bypass that ground-drape step and remain on their own vertical layer.

```text
game_road centerline + width
          │
          ├─ ground road ── sample/smooth DEM ── carriageway mesh
          ├─ bridge ─────── independent deck Z ─ carriageway mesh
          └─ tunnel ─────── independent path Z ─ hidden/portal geometry
```

## World-streaming direction

MapLibre remains responsible for global geographic context. The game/world layer should operate in a local metric frame with a floating origin shared by terrain, detailed buildings, roads and physics.

Expensive decoding/mesh generation should migrate toward workers. Candidate sets and collision geometry must be bounded by distance, tile count and/or frame-time budgets just as building LOD3 is today.

## Near-term acceptance criteria

Before vehicle physics becomes the focus, Mapshow should be able to:

- render real DEM terrain and terrain-aware custom geometry; *(implemented)*
- stream bounded LOD3 building geometry with explicit GPU cleanup; *(implemented)*
- generate a versioned simulation-road MVT tileset from OSM; *(implemented)*
- retain source road identity, dimensions, access, direction and vertical-layer metadata; *(implemented)*
- attach a separately hosted game-road TileJSON source in the browser; *(implemented adapter)*
- stitch nearby road geometry across tile edges;
- construct intersection-aware local road graph segments;
- distinguish true intersections from bridge/tunnel crossings;
- generate terrain-reconciled road surfaces and near-player collision geometry.
