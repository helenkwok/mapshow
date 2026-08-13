# Architecture

Mapshow is built as replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap into immutable tiles rather than query Overpass while the player moves.
2. **Do not confuse cartography with simulation.** OpenMapTiles is visual context; simulation road data has a separate schema.
3. **Keep terrain independent from vector maps.** Elevation has its own provider interface.
4. **Generate detail near the viewer.** Expensive geometry and collision are bounded near the camera/player.
5. **Bound every expensive layer.** Dense cities degrade to cheaper LODs rather than growing GPU allocations without limit.
6. **Preserve provenance and identity.** OSM feature/node/relation IDs and data licences survive preprocessing wherever the world layer needs traceability.
7. **Keep policy separate from physical geometry.** Access restrictions, turn legality and traffic rules do not decide whether a physical road exists in the world mesh.
8. **Keep physics behind an adapter.** Collision geometry is produced independently of a chosen physics or vehicle library.
9. **Keep offline generation scalable.** The road generator uses multi-pass PBF processing and disk-backed scratch state rather than loading a planet-scale road dataset into RAM.

## Data planes

```text
                        OpenStreetMap
                         /          \
                        /            \
             OpenFreeMap MVT      Mapshow game-road MVT
                 │                       ▲
                 │ visual               │ Rust generator
                 ▼                       │
          MapLibre basemap          OSM .pbf
                 │                       │
AWS/Tilezen DEM ─┤                       ▼
                 ▼                  local road graph
          MapLibre terrain               │
                 │                       ├─ lane network
                 ├───────────────┐       ├─ turn policy
                 ▼               ▼       ├─ road profiles
             building LODs      local    └─ intersections
                             Three.js world      │
                                                ▼
                                      simplified collision world
                                                │
                                        future physics adapter
```

The visual and simulation road products are intentionally independent. A future visual-style change must not modify driving geometry, and a road-physics schema change must not require rebuilding OpenFreeMap.

## Terrain and buildings

`src/map/terrain.ts` owns the elevation-provider boundary. The current provider is the AWS Open Data `elevation-tiles-prod` Terrarium dataset. MapLibre renders the terrain and exposes `queryTerrainElevation()` for custom world geometry.

Building LOD3 uses bounded Three.js geometry anchored to sampled DEM height. The current building budget is 24 buildings within 260 m at close zoom, with explicit geometry caps and disposal.

## Rust game-road preprocessing — schema v3

`road-schema/` is a Rust binary/library that emits the `game_road` simulation layer at zoom 12–16. It replaces the earlier Java/Planetiler implementation while keeping the schema-v3 browser contract.

The production generator is multi-pass and disk-backed:

```text
OSM .pbf
  │
  ├─ pass 1: identify roads + count road-node usage + parse restriction relations
  │                                      │
  │                                      ▼
  │                                  redb scratch
  │
  ├─ pass 2: store coordinates only for referenced road nodes
  │                                      │
  │                                      ▼
  │                                  redb scratch
  │
  └─ pass 3: split ways at shared road nodes
       ├─ preserve source direction
       ├─ normalize schema-v3 attributes
       ├─ attach restriction metadata
       ├─ project/clip buffered MVT geometry
       └─ spool tile records to disk
                    │
                    ▼
             ordered tile spool
                    │
             one tile at a time
               ┌────┴────┐
               ▼         ▼
          XYZ MVT      PMTiles
          + TileJSON   v3 archive
```

The generator uses:

- `osmpbf` for OSM PBF decoding;
- `redb` for temporary disk-backed node/tile scratch state;
- a small local `prost`-based Mapbox Vector Tile encoder;
- `pmtiles-rs` for optional PMTiles output.

Shared-node splitting is derived directly from OSM topology: an internal node referenced by more than one included simulation-road way becomes a split point. Way endpoints remain endpoints. A geometric 2D crossing without a shared OSM node therefore does not become a graph connection.

Each result retains:

- `segment_id`: deterministic topology-segment identity within JavaScript's exact integer range;
- `osm_id`: parent OSM way identity;
- `first_node` / `last_node`;
- total and directional lane tags;
- raw `turn:lanes*` and `change:lanes*` strings;
- tagged speeds and `width_m` with provenance;
- surface/ride metadata;
- access/vehicle restrictions;
- `oneway`;
- bridge/tunnel/layer metadata;
- compact restriction-relation metadata attached to from-way segments.

Turn restrictions are parsed during pass 1 and transported with from-way segments. Conditional and via-way restrictions are preserved even when the browser cannot yet enforce them.

CI validates the Rust generator with unit tests and a real small Monaco OSM PBF, requiring both non-empty XYZ MVT/TileJSON and PMTiles output.

## Browser road-world assembly

`src/map/game-roads.ts` validates schema v3. `src/map/road-world.ts` converts loaded source features into a bounded local topology world.

```text
loaded game_road features
        │
        ├─ group by segment_id
        ├─ remove duplicate clipped appearances
        ├─ stitch only direction-preserving overlaps
        ├─ keep multipart fallback when necessary
        └─ bound by distance / segment count
                    │
                    ▼
            directed road graph
```

Direction-preserving stitching matters because source first-node → last-node orientation is also the reference direction for `oneway`, directional lane tags and lateral lane placement.

Access/private/no-access fields stay on the physical road records. They are routing-policy inputs, not a filter that deletes the road mesh.

Current road-world budget:

```text
minimum zoom              14.5
camera radius             650 m
maximum active segments   240
```

The browser currently consumes a vector TileJSON endpoint. PMTiles is an alternate output format behind the offline generator; a direct PMTiles source adapter can be added separately without changing road topology or schema.

## Reusable road elevation profile

`src/map/road-profile.ts` creates the vertical profile reused by rendering and collision generation.

```text
road centerline
      │
      ├─ densify to <= ~8 m spacing
      ├─ sample DEM
      ├─ smooth local height noise
      ├─ constrain grade by road class
      └─ ease bridge/tunnel offsets near ground connections
                    │
                    ▼
             metric Z profile
```

Major roads get tighter grade limits than local roads/tracks. Ground roads retain terrain shape rather than becoming globally flat. Bridges and tunnels use stronger smoothing plus an eased transition when their topology endpoint connects to a different vertical mode.

Bridge deck/tunnel floor height is still heuristic because ordinary OSM data rarely provides surveyed vertical geometry. This layer is world-generation geometry, not engineering design data.

## Lane network and turn policy

`src/map/road-lanes.ts` derives directed logical lanes from each topology segment.

Explicit lane metadata takes precedence:

```text
lanes + lanes:forward + lanes:backward
                 │
                 ▼
       directional lane counts
                 │
   fallback only when tags are absent
                 ▼
        width-based lane inference
```

For a one-lane two-way road, two directed logical lanes share one physical center path. Multilane roads get lateral offsets inside `width_m`.

Traffic side is explicit rather than guessed globally. Presets select the known side for Adelaide, Hong Kong, Manhattan and Tokyo, and the UI allows manual left/right switching elsewhere.

The lane network first creates geometric candidate incoming → outgoing connections at graph nodes. A separate policy pass then filters them:

1. `turn:lanes:forward` / `turn:lanes:backward`, or `turn:lanes` on a one-way road, are aligned left-to-right in the direction of travel and restrict each tagged lane to left/through/right movements;
2. simple unconditional via-node OSM restriction relations enforce `no_*` and `only_*` movement rules using the from parent `osm_id`, shared `via_node` and target parent `osm_id`.

Restrictions with `except=motorcar`, `motor_vehicle`, or `vehicle` do not apply to the generic car policy. Conditional and via-way restrictions are retained but counted as unenforced instead of guessed. `change:lanes*` is preserved for a later lane-change policy stage.

The network reports candidate count, legal count, turn-lane filtering, relation filtering and preserved-but-unenforced restriction count separately.

## Intersection geometry

`src/map/road-intersections.ts` builds a physical intersection shape from road headings and widths rather than an arbitrary radius. It intentionally does not yet model channelized islands, medians, signal stop lines or complex divided junctions.

## Road surface renderer and collision world

`src/map/road-surface-layer.ts` consumes the graph, road profiles, lane layouts and intersection polygons.

```text
road profile + width_m ──> carriageway strips
lane layout            ──> lane-center guide strips
shared graph nodes     ──> intersection polygons
same local profiles    ──> simplified collision bodies
```

The same smoothed Z profile drives the carriageway, lane guides and collision representation so they cannot disagree vertically.

`src/map/road-collision.ts` defines a renderer-independent triangle-body contract. Segment centerlines are reduced to roughly 12 m collision spacing before generating a full-width strip. Intersections reuse the prepared junction polygon. Each body keeps local positions/indices plus its Mercator origin, meter scale and surface/vertical metadata.

This collision world is intentionally not a Three.js mesh API and intentionally does not choose Rapier, Jolt, Bullet or another physics engine. A later physics adapter can translate the bodies into static colliders while preserving the current road/world generator.

Geometry remains bounded and cached; stale render `BufferGeometry` and stale collision records are removed when segments leave the local world or their terrain/profile configuration changes.

## Runtime integration

`src/main.ts` owns streaming policy and world controls. When a dedicated TileJSON is configured it:

- installs the simulation vector source;
- builds the local road graph;
- derives lane topology using the current traffic side;
- filters candidate lane connectivity through turn policy;
- creates smoothed road profiles;
- streams carriageways/intersections/lane guides;
- maintains a matching simplified collision world;
- refreshes as the camera or DEM changes;
- exposes traffic-side and road-surface controls plus policy/collision runtime counts.

Without `VITE_GAME_ROADS_TILEJSON`, simulation road surfaces remain disabled. OpenFreeMap roads are never silently promoted to physics geometry.

## Remaining boundary before vehicle dynamics

Implemented now:

- real DEM terrain;
- bounded procedural building LODs;
- Rust topology-split road MVT generation;
- disk-backed scalable road preprocessing;
- XYZ MVT/TileJSON and PMTiles output;
- direction-preserving tile-fragment assembly;
- directed local graph;
- smoothed/grade-limited road profiles;
- bridge/tunnel approach easing;
- approach-shaped intersection polygons;
- explicit left/right traffic;
- directed lane centerlines;
- `turn:lanes*` policy;
- simple unconditional via-node OSM restriction enforcement;
- renderer-independent simplified road/intersection collision bodies.

Still separate:

- via-way and conditional restriction evaluation;
- signal phases and jurisdiction-specific rules;
- `change:lanes*` lane-change legality;
- legal routing/route search interface;
- player-centric floating origin and worker-based runtime road generation;
- physics-engine adapter;
- vehicle suspension, tire forces and controller behavior;
- higher-resolution regional terrain/road elevation refinement.
