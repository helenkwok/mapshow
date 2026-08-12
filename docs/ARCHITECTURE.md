# Architecture

Mapshow is built as replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap into immutable tiles rather than query Overpass while the player moves.
2. **Do not confuse cartography with simulation.** OpenMapTiles is visual context; simulation road data has a separate schema.
3. **Keep terrain independent from vector maps.** Elevation has its own provider interface.
4. **Generate detail near the viewer.** Expensive geometry and collision are bounded near the camera/player.
5. **Bound every expensive layer.** Dense cities degrade to cheaper LODs rather than growing GPU allocations without limit.
6. **Preserve provenance and identity.** OSM feature/node IDs and data licences survive preprocessing wherever the world layer needs traceability.

## Data planes

```text
                        OpenStreetMap
                         /          \
                        /            \
             OpenFreeMap MVT      Mapshow game-road MVT
                 │                       │
                 │ visual               │ simulation
                 ▼                       ▼
          MapLibre basemap        local directed graph
                 │                       │
                 ├──────────────┐        ▼
                 │              │   carriageway meshes
AWS/Tilezen DEM ─┤              │        │
                 ▼              ▼        ▼
          MapLibre terrain   building LODs / road surfaces
                        \       /         /
                         \     /         /
                          local world layer
                                 │
                           Three.js/physics
```

The visual and simulation road products are intentionally independent. A future visual-style change must not modify driving geometry, and a road-physics schema change must not require rebuilding OpenFreeMap.

## Terrain

`src/map/terrain.ts` owns the elevation-provider boundary. The first provider is the public AWS Open Data `elevation-tiles-prod` Terrarium dataset. MapLibre decodes the raster DEM, renders terrain/hillshade, and exposes `queryTerrainElevation()`.

Custom Three.js building geometry samples DEM elevation and anchors its Mercator origin to ground Z. Road surfaces also sample the same DEM so both detail systems share the map's terrain datum.

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

`src/map/building-feature.ts` extracts/deduplicates real vector-tile footprints and carries sampled terrain height. `src/map/building-detail-layer.ts` owns Three.js geometry, keyed caching, terrain anchoring and disposal. `src/main.ts` owns streaming policy.

## Game-road preprocessing — schema v2

`road-schema/` is the simulation-road preprocessing boundary. It uses Planetiler v0.10.2 with Java 21 and emits `game_road` MVT from zoom 12 through 16.

The key change in schema v2 is **source-side intersection splitting**. `MapshowRoadProfile.splitOsmWayAtIntersections()` opts supported road ways into Planetiler's OSM-way splitter and `FeatureCollector.splitLine()` emits the resulting pieces.

```text
OSM way
 A ─── B ─── C ─── D
           │
           └── another road
               │
               ▼
Planetiler shared-node split
 A ─── B ─── C    C ─── D
        segment 1   segment 2
```

Each output feature therefore has:

- `segment_id`: unique intersection-to-intersection segment identity;
- `osm_id`: stable parent OSM way identity;
- `first_node` / `last_node`: OSM node IDs at the segment endpoints;
- `node_count`: retained source vertices inside the segment;
- driving dimensions/properties and vertical-separation tags.

Distinct OSM ways are not post-merged. Geometric crossings without a shared OSM node do not become graph junctions merely because their lines cross in 2D.

### Road contract

The versioned machine-readable contract is `road-schema/schema.json`.

**Identity/topology**

- `schema_version = 2`
- `segment_id`
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

Raw OSM fields are retained beside normalized fields. `speed_kmh` is emitted only for a parseable tagged maxspeed; jurisdiction-specific defaults are not invented. `width_m` may be estimated, with `width_source` recording explicit tag, lane-derived, or class fallback provenance.

## Browser road-world assembly

`src/map/game-roads.ts` validates schema v2 and provides the independent TileJSON adapter. `src/map/road-world.ts` converts loaded vector-source features into a bounded local road world.

```text
loaded game_road source features
             │
             ├─ group by segment_id
             ├─ deduplicate clipped copies
             ├─ stitch safe overlapping fragments
             ├─ retain multipart fallback when needed
             └─ bound by camera distance / segment count
                         │
                         ▼
                 local directed graph
```

The graph is keyed by OSM endpoint node IDs. `oneway` determines whether one or two directed arcs are created for each road segment. Access fields remain in the records for later routing/vehicle policy.

Current road-world budget:

```text
minimum zoom              14.5
camera radius             650 m
maximum active segments   240
```

`querySourceFeatures()` can return several clipped appearances of the same source segment as tiles load. Grouping by `segment_id` and overlap-aware stitching prevents those appearances from becoming duplicate graph edges.

## Driveable road-surface representation

`src/map/road-surface-layer.ts` converts each active graph segment into local metric Three.js geometry.

```text
centerline + width_m
        │
        ├─ densify to <= ~8 m sample spacing
        ├─ sample terrain Z
        ├─ derive local tangent / perpendicular
        ├─ offset +/- width_m / 2
        └─ triangulate strip
                 │
                 ▼
          carriageway surface
```

Ground roads use DEM elevation plus a small anti-z-fighting lift. Paved, unpaved and unknown surfaces use separate shared materials. Road geometry is cached per `segment_id`; geometry is disposed when a segment leaves the active set or rebuilt when its sampled terrain fingerprint changes.

### Junctions

Shared graph nodes with at least two incident active segments receive a bounded junction pad. This closes the visual hole where independent carriageway strips meet.

The pad is intentionally a first implementation. It is not a substitute for a proper intersection polygon generated from the incoming carriageway boundaries and turn geometry.

### Bridges and tunnels

`bridge`, `tunnel`, and `layer` prevent grade-separated roads from collapsing onto the ground surface. The current Z calculation uses provisional minimum bridge clearance / tunnel-depth heuristics because OSM usually lacks surveyed deck or tunnel-floor elevation.

```text
ground road ── DEM sample + small lift
bridge      ── DEM + provisional clearance/layer offset
tunnel      ── DEM - provisional depth/layer offset
```

A later refinement stage should use explicit elevation tags where available, smooth grades across approaches, and model decks/portals separately.

## Runtime integration

`src/main.ts` owns both building and road streaming policy.

When `VITE_GAME_ROADS_TILEJSON` is configured, Mapshow:

1. installs the independent vector source;
2. queries loaded `game_road` source features;
3. builds the bounded local graph;
4. streams carriageway surfaces into a Three.js custom layer;
5. refreshes them as the map moves or DEM tiles become available;
6. exposes a road-surface toggle and runtime graph statistics.

Without the TileJSON, road surfaces stay disabled. Mapshow does not silently use OpenFreeMap's cartographic roads as simulation geometry.

## What is not solved yet

The current road layer is topology-aware and visually driveable, but it is not vehicle physics yet. Remaining road/world work includes:

- robust intersection polygons instead of circular junction pads;
- lane-centerline generation and lane connectivity;
- grade smoothing and bridge/tunnel approach continuity;
- OSM turn restrictions and route relation handling;
- separate simplified collision meshes / physics bodies;
- player-centric floating origin;
- worker-based decoding/mesh generation and frame-time budgets;
- vehicle suspension, tires and control.

## Near-term acceptance criteria

Before full vehicle physics becomes the focus, Mapshow should be able to:

- render real DEM terrain and terrain-aware custom geometry; *(implemented)*
- stream bounded LOD3 building geometry with explicit GPU cleanup; *(implemented)*
- generate a versioned simulation-road MVT tileset from OSM; *(implemented)*
- split supported roads at real shared OSM junction nodes before tiling; *(implemented)*
- deduplicate/stitch nearby game-road tile fragments; *(implemented)*
- construct a directed local graph from OSM endpoint nodes and `oneway`; *(implemented)*
- distinguish graph junctions from non-connected bridge/tunnel crossings; *(implemented through OSM shared-node topology + vertical tags)*
- generate bounded, DEM-aligned metric carriageway surfaces; *(implemented foundation)*
- generate proper intersection/lane geometry and near-player collision bodies; *(next)*
