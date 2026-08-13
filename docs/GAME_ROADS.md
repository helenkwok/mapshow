# Game-road tiles

Mapshow keeps **visual map tiles** and **simulation road tiles** separate.

OpenFreeMap/OpenMapTiles remains the visual basemap. `road-schema/` builds a second MVT tileset from OpenStreetMap with a dedicated Rust generator, retaining topology and driving metadata that a cartographic schema may normalize or omit.

## Output contract — schema v3

- Vector layer: `game_road`
- Zoom range: 12–16
- Geometry: OSM road lines split at shared OSM road nodes before vector-tile clipping
- Source-way identity: `osm_id`
- Topology-segment identity: deterministic JS-safe `segment_id`
- Machine-readable property contract: [`../road-schema/schema.json`](../road-schema/schema.json)

Important fields include:

- `segment_id`, `osm_id`, `first_node`, `last_node`;
- road class and priority;
- total/directional lane counts;
- `turn:lanes*` and `change:lanes*` raw strings;
- tagged `speed_kmh` when parseable;
- `width_m` plus width provenance;
- surface/ride metadata;
- `oneway`;
- bridge/tunnel/layer;
- access/vehicle restrictions;
- compact turn-restriction relation metadata.

`speed_kmh` is intentionally not guessed when OSM lacks a parseable `maxspeed`. `width_m` may be estimated because generated road geometry needs a physical width; `width_source` records whether it came from explicit width, lane count or a class fallback.

## Rust preprocessing architecture

The generator is Rust-only and does not depend on Java, Maven or Planetiler.

```text
OSM .pbf
  │
  ├─ pass 1
  │    ├─ identify simulation roads
  │    ├─ count road-node usage
  │    └─ parse type=restriction relations
  │              │
  │              ▼
  │          redb scratch
  │
  ├─ pass 2
  │    └─ retain coordinates only for referenced road nodes
  │              │
  │              ▼
  │          redb scratch
  │
  └─ pass 3
       ├─ split road ways at shared road nodes
       ├─ preserve source direction
       ├─ normalize schema-v3 attributes
       ├─ attach restriction metadata
       ├─ project and clip buffered MVT LineStrings
       └─ spool per-tile feature records to disk
                    │
                    ▼
             one tile at a time
               ┌────┴────┐
               ▼         ▼
          XYZ .pbf    PMTiles v3
          + TileJSON   archive
```

`osmpbf` performs PBF decoding, `redb` provides temporary disk-backed scratch state, a small local `prost` encoder writes Mapbox Vector Tile protobuf, and `pmtiles-rs` writes optional PMTiles v3 output.

The scratch database is temporary build state and is removed with its temporary directory.

## Shared-node splitting

Pass 1 counts how many included simulation-road ways reference each OSM node. During pass 3, an internal node becomes a topology split point when it is referenced by more than one included road way. Way endpoints are always segment endpoints.

This distinguishes:

- roads sharing an OSM node and therefore able to connect; from
- lines merely crossing geometrically in 2D and therefore not forming a graph connection.

Source first-node → last-node direction is preserved through splitting/clipping because `oneway`, directional lane tags, turn-lane alignment and lateral lane placement depend on that orientation.

## Turn restriction transport

The Rust first pass parses OSM `type=restriction` relations and retains:

- relation ID;
- `restriction` value;
- `from` way;
- `to` way;
- `via_node` or `via_way`;
- `except` modes;
- `restriction:conditional` when present.

For segments whose parent way is a restriction's `from` way, schema v3 writes compact restriction metadata in `turn_restrictions`.

The browser currently enforces simple unconditional via-node restrictions. Via-way and conditional restrictions stay preserved and are counted as unenforced rather than guessed.

## Build and test the generator

Requirements: stable Rust compatible with `road-schema/Cargo.toml`.

```bash
cargo fmt --manifest-path road-schema/Cargo.toml --all -- --check
cargo test --manifest-path road-schema/Cargo.toml --all-targets
```

Build static XYZ MVT plus TileJSON:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-xyz \
  --input data/region.osm.pbf \
  --output-dir data/game-roads \
  --tile-url-template 'https://tiles.example.com/game-roads/{z}/{x}/{y}.pbf'
```

Build PMTiles v3 instead:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-pmtiles \
  --input data/region.osm.pbf \
  --output data/game-roads.pmtiles
```

CI also downloads a real Monaco OSM PBF and requires both output paths to produce non-empty artifacts. This complements Rust unit tests for normalization, restriction parsing, IDs, MVT encoding and scratch ordering.

## Browser source configuration

The current web runtime consumes TileJSON:

```bash
VITE_GAME_ROADS_TILEJSON=https://tiles.example.com/game-roads/tilejson.json
VITE_GAME_ROADS_DEBUG=false
```

PMTiles is generated as an alternative static distribution artifact. Direct PMTiles loading is not wired into the browser yet.

When no TileJSON is configured, simulation road surfaces and physics are disabled instead of substituting OpenFreeMap's cartographic roads.

## Browser road-world assembly

`src/map/road-world.ts` builds a bounded topology world from loaded `game_road` source features:

1. validate schema v3;
2. group clipped features by `segment_id`;
3. stitch only direction-preserving fragment overlaps;
4. keep multipart fallback when clipping prevents safe merging;
5. connect graph arcs through OSM `first_node` / `last_node` IDs;
6. apply `oneway` to directed graph arcs;
7. keep access metadata on physical roads for later routing policy;
8. enforce a 650 m / 240-segment local-world budget.

The runtime begins at map zoom 14.5.

## Elevation profile

`src/map/road-profile.ts` produces a reusable metric vertical profile:

```text
centerline
   │
   ├─ densify to about 8 m samples
   ├─ query DEM
   ├─ smooth local height noise
   ├─ constrain grade by road class
   └─ ease bridge/tunnel offsets near mixed-mode endpoints
            │
            ▼
      reusable road profile
```

The same profile feeds rendering and collision so those layers agree vertically.

Bridge deck and tunnel-floor heights remain heuristic because normal OSM data does not consistently contain surveyed vertical geometry.

## Intersections, lanes and legal turns

`src/map/road-intersections.ts` creates approach-shaped junction polygons from incident headings and widths.

`src/map/road-lanes.ts` derives directed logical lanes. Explicit `lanes`, `lanes:forward` and `lanes:backward` take precedence; width-based lane inference is used only when those tags are absent.

Traffic side is explicit. Adelaide, Hong Kong and Tokyo presets use left-hand traffic; Manhattan uses right-hand traffic; the UI can switch manually elsewhere.

The lane network builds geometric candidate connections, then filters them with:

1. `turn:lanes:forward` / `turn:lanes:backward`, or one-way `turn:lanes`;
2. simple unconditional OSM `no_*` / `only_*` via-node restrictions.

`except=motorcar`, `motor_vehicle` or `vehicle` makes a restriction non-applicable to the generic car policy. Conditional/via-way restrictions remain visible but unenforced. `change:lanes*` is preserved for a later policy stage.

## Surface renderer and collision world

`src/map/road-surface-layer.ts` produces related products from the same local road profile:

```text
road profile + width_m ──> carriageway triangle strips
lane layout            ──> lane-center guide strips
shared graph nodes     ──> approach-shaped intersection polygons
same profiles          ──> simplified collision triangle bodies
```

`src/map/road-collision.ts` defines the renderer-independent collision contract. Segment collision centerlines are simplified to roughly 12 m spacing before strip generation; intersection collision reuses the prepared junction polygon.

Each collision body retains its local geometry, Mercator origin/scale and relevant surface/vertical metadata.

## Physics consumption

The collision world remains independent of Rapier even though Rapier is now the active browser physics engine.

The current chain is:

```text
RoadCollisionWorld
        │
        ▼
RoadPhysicsAdapter
X east / Y up / Z north metres
        │
        ▼
PhysicsSyncBatch
created / updated / removed
        │
        ▼
RapierPhysicsWorld
static road/intersection trimeshes
+ dynamic probe + minimal chassis
```

`RoadPhysicsAdapter` owns stable IDs and coordinate conversion. `RapierPhysicsWorld` never reads OSM features, MapLibre road geometry or Three.js road meshes directly.

The floating origin currently follows the camera/player proxy and rebases after about 400 m. Static colliders are re-expressed in the new frame; dynamic probe/chassis positions are transformed so their physical world location is preserved.

## Current vehicle boundary

The road world already provides topology, legal lane connectivity, terrain-aware surfaces and collision geometry. Rapier now provides the static environment plus diagnostic dynamic bodies.

The current minimal chassis uses direct thrust/yaw/brake forces only to validate persistent controlled motion. It is **not** the final vehicle model.

Still separate:

- via-way and conditional turn restrictions;
- signal phases and jurisdiction-specific rules;
- `change:lanes*` legality;
- route search and lane following;
- wheel/suspension model;
- tyre friction/slip/contact forces;
- production steering/throttle/brake behavior;
- dynamic traffic.
