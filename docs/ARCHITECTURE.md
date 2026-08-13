# Architecture

Mapshow is built as replaceable data, world-generation and physics adapters rather than a monolithic renderer.

## Principles

1. **Keep global map delivery cheap.** Use immutable map/vector tiles instead of runtime Overpass queries.
2. **Do not confuse cartography with simulation.** OpenFreeMap/OpenMapTiles is visual context; game roads use a dedicated schema.
3. **Keep terrain independent from vector maps.** Elevation has its own provider boundary.
4. **Generate expensive detail near the viewer/player.** Detailed buildings, road meshes and collision are bounded locally.
5. **Bound every expensive layer.** Dense cities fall back to cheaper LODs rather than growing memory/GPU use without limit.
6. **Preserve provenance and identity.** OSM way/node/relation identity survives preprocessing where the simulation layer needs it.
7. **Keep policy separate from physical geometry.** Access and turn legality do not decide whether a physical road mesh exists.
8. **Keep collision generation separate from the physics engine.** Renderer-independent collision triangles are translated through an adapter before Rapier sees them.
9. **Keep offline generation scalable.** The Rust road generator uses multi-pass PBF processing and disk-backed scratch state.
10. **Keep geographic rendering separate from dynamic-body coordinates.** Rapier operates in a floating local metre frame, not Web Mercator.
11. **Test the boundaries, not only compilation.** Browser unit tests lock coordinate, collision, adapter and chassis-actuation contracts; Rust CI also performs real PBF smoke builds.

## Data planes

```text
                         OpenStreetMap
                         /           \
                        /             \
             OpenFreeMap MVT      Mapshow game-road MVT
                 │                       ▲
                 │ visual               │ Rust generator
                 ▼                       │
          MapLibre basemap          OSM .pbf
                 │
AWS/Tilezen DEM ─┤
                 ▼
          MapLibre terrain
                 │
                 ├───────────────┐
                 ▼               ▼
           building LODs      road profiles
                 │               │
                 └──────┬────────┘
                        ▼
                    Three.js
              LOD3 buildings + roads
                        │
                        ▼
             simplified collision world
                        │
                        ▼
              RoadPhysicsAdapter
              local metre coordinates
                        │
                        ▼
                     Rapier
              static road/intersection
                + probe + chassis
```

The visual and simulation road products are intentionally independent. A visual-style change must not silently alter driving geometry, and a simulation schema change must not require rebuilding the OpenFreeMap basemap.

## Terrain and buildings

`src/map/terrain.ts` owns the elevation-provider boundary. The current default is the AWS Open Data `elevation-tiles-prod` Terrarium dataset. MapLibre renders terrain and exposes elevation sampling for custom world geometry.

Building detail is layered:

```text
LOD1  map footprint → simple extrusion
LOD2  footprint + height → segmented/patterned façade
LOD3  nearby footprint → generated windows, entrance and roof geometry
```

LOD3 is bounded by zoom, distance and active-building count. Geometry is disposed when buildings leave the active detail set.

## Rust game-road preprocessing — schema v3

`road-schema/` is a Rust binary/library that emits the `game_road` simulation layer at zoom 12–16.

The production path is multi-pass and disk-backed:

```text
OSM .pbf
  │
  ├─ pass 1: identify roads + count shared-node use + parse restriction relations
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
             one tile at a time
               ┌────┴────┐
               ▼         ▼
          XYZ MVT      PMTiles
          + TileJSON   v3 archive
```

Important schema properties include:

- deterministic JS-safe `segment_id`;
- parent `osm_id`;
- `first_node` / `last_node` topology IDs;
- lane and directional-lane tags;
- raw `turn:lanes*` / `change:lanes*`;
- `speed_kmh` when explicitly parseable;
- estimated or explicit `width_m` plus provenance;
- surface/access/vehicle metadata;
- `oneway`, bridge/tunnel/layer;
- compact restriction-relation metadata.

Shared-node splitting uses actual OSM topology. A geometric crossing without a shared OSM node therefore does not become a graph connection.

## Browser road-world assembly

`src/map/game-roads.ts` validates schema v3. `src/map/road-world.ts` groups clipped features by `segment_id`, stitches only direction-preserving overlaps, keeps multipart fallback where necessary, and builds a bounded local directed graph from `first_node`, `last_node` and `oneway`.

Current road-world budget:

```text
minimum zoom              14.5
camera radius             650 m
maximum active segments   240
```

The browser currently consumes vector TileJSON. PMTiles is generated as an alternative distribution artifact but does not yet have a direct browser source adapter.

## Road elevation and geometry

`src/map/road-profile.ts` creates the metric vertical profile reused by rendering and collision:

```text
road centerline
      │
      ├─ densify to <= ~8 m spacing
      ├─ sample DEM
      ├─ smooth local noise
      ├─ constrain grade by road class
      └─ ease bridge/tunnel offsets near ground connections
                    │
                    ▼
             reusable Z profile
```

`src/map/road-intersections.ts` creates approach-shaped junction polygons from incident headings and physical widths.

`src/map/road-surface-layer.ts` generates carriageway strips, lane guides, intersection surfaces and the matching simplified collision representation from the same profiles.

Bridge/tunnel vertical positions remain world-generation heuristics because normal OSM data does not consistently contain surveyed deck/floor elevations.

## Lane network and turn policy

`src/map/road-lanes.ts` derives directed logical lanes. Explicit lane tags take precedence; width-based inference is a fallback only when lane metadata is absent.

Traffic side is explicit. Presets select left/right driving where known, and the UI allows manual switching.

Candidate incoming → outgoing lane connections are filtered by:

1. `turn:lanes:forward`, `turn:lanes:backward`, or one-way `turn:lanes`;
2. simple unconditional via-node OSM `no_*` / `only_*` restriction relations.

Conditional and via-way restrictions are preserved but not guessed. `change:lanes*` is preserved for a later lane-change policy stage.

## Collision boundary

`src/map/road-collision.ts` defines renderer-independent road/intersection triangle bodies. Segment centerlines are simplified to roughly 12 m collision spacing; intersection collision reuses the prepared junction polygon.

`src/map/physics-adapter.ts` converts those bodies into a physics-neutral local convention:

```text
+X east
+Y up
+Z north
units: metres
```

It owns stable collider IDs and emits created/updated/removed sync batches. Rapier does not read MapLibre features or Three.js road meshes directly.

## Floating origin

`src/map/floating-origin.ts` owns the local physics frame. The camera currently acts as the temporary player proxy. The frame rebases after roughly 400 m.

A rebase:

- does not rebuild OSM topology;
- does not rebuild visual Three.js road geometry solely because coordinates moved;
- retransforms static collider descriptors through `RoadPhysicsAdapter`;
- retransforms active dynamic-body positions so their world location is preserved.

Terrain mode changes force an origin reset so the local vertical datum cannot retain stale DEM elevation.

## Rapier runtime

`src/map/rapier-physics.ts` owns the Rapier world behind the engine-neutral adapter.

Implemented now:

- one standalone static trimesh per streamed road/intersection collision body;
- surface-class friction defaults and zero road restitution;
- fixed 1/60 s stepping with bounded catch-up;
- a small dynamic drop probe for contact/rebase diagnostics;
- a minimal 1,200 kg single-body chassis;
- temporary direct thrust/yaw/brake controls used only for dynamic-body validation;
- dynamic-body rebasing across floating-origin revisions.

`src/map/rapier-debug-layer.ts` renders Rapier debug geometry back into the MapLibre/Three.js scene using the current floating-origin transform.

The minimal chassis is intentionally not a final car. Rapier's rigid-body force/torque APIs are being used only to validate persistent controlled motion before suspension and tyre forces replace that direct actuation path.

## Runtime ownership

`src/main.ts` owns high-level streaming and UI policy:

- installs terrain, game-road and building layers;
- refreshes bounded road/building worlds;
- keeps the floating origin aligned with the current camera/player proxy;
- applies collider sync batches to Rapier;
- advances fixed-step physics independently of map refreshes;
- manages probe/chassis spawn, debug display and temporary chassis controls;
- clears dynamic/static physics when the simulation road world is disabled or reset.

Without `VITE_GAME_ROADS_TILEJSON`, simulation road surfaces and physics remain disabled. OpenFreeMap roads are never silently promoted to simulation geometry.

## Testing architecture

Browser tests use Vitest and currently cover:

- floating-origin rebasing and round trips;
- collision-strip simplification/index generation;
- collider-adapter create/update/remove behavior;
- minimal chassis input/orientation/force math.

CI separately runs `npm run build` for strict TypeScript + Vite output.

Rust CI runs formatting and unit tests, then downloads a real Monaco OSM PBF and requires non-empty XYZ MVT/TileJSON and PMTiles outputs.

## Remaining boundaries

Still separate from the current minimal chassis:

- via-way and conditional restriction evaluation;
- signal phases and jurisdiction-specific traffic rules;
- `change:lanes*` lane-change legality;
- route search and lane following;
- wheel/suspension model;
- tyre friction/slip and surface-contact model;
- production steering/throttle/brake behavior;
- dynamic traffic and collision filtering;
- higher-resolution regional terrain/road elevation refinement.
