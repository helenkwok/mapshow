# Game-road tiles

Mapshow keeps **visual map tiles** and **simulation road tiles** separate.

OpenFreeMap/OpenMapTiles remains the visual basemap. The `road-schema/` module builds a second MVT tileset from OpenStreetMap with a dedicated Rust generator, retaining attributes that a driving/world engine needs and that a cartographic schema may normalize or omit.

## Output contract — schema v3

- Vector layer: `game_road`
- Zoom range: 12–16
- Geometry: OSM road lines split at shared OSM road nodes before vector-tile clipping
- Source-way identity remains available through `osm_id`
- Each intersection-to-intersection piece has a deterministic `segment_id` that stays within JavaScript's exact integer range
- Different OSM roads are not merged as a preprocessing shortcut
- Machine-readable property contract: [`../road-schema/schema.json`](../road-schema/schema.json)

Important fields include `segment_id`, `osm_id`, road class, total/directional lanes, tagged speeds, `width_m` with provenance, surface/ride metadata, `oneway`, bridge/tunnel/layer, access restrictions, first/last OSM node IDs, raw `turn:lanes*` / `change:lanes*` strings, and compact turn-restriction relation metadata.

`speed_kmh` is intentionally **not guessed** when OSM lacks a parseable `maxspeed`. `width_m` may be estimated because a driveable mesh needs a physical width; `width_source` records whether it came from an explicit width tag, lane count, or class fallback.

## Rust preprocessing architecture

The generator no longer depends on Java, Maven or Planetiler. It uses a multi-pass Rust pipeline so large extracts do not require all road nodes, road geometries and tile features to remain in memory simultaneously.

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
       ├─ split road ways at nodes shared by multiple simulation roads
       ├─ preserve source direction
       ├─ normalize schema-v3 attributes
       ├─ attach turn-restriction metadata to from-way segments
       ├─ project and clip buffered MVT LineStrings
       └─ spool per-tile feature records to disk
                    │
                    ▼
             ordered tile spool
                    │
             one tile at a time
               ┌────┴────┐
               ▼         ▼
          XYZ .pbf    PMTiles v3
          + TileJSON   archive
```

`osmpbf` performs PBF decoding, `redb` is temporary disk-backed scratch state, a small local encoder writes Mapbox Vector Tile protobuf, and `pmtiles-rs` writes the optional single-file PMTiles archive.

The scratch database exists only while a build is running and is removed with its temporary directory afterward.

## Shared-node splitting

The first pass counts how many simulation-road ways reference each OSM node. During the third pass, an internal node becomes a topology split point when it is referenced by more than one included road way. Way endpoints are always segment endpoints.

This preserves the important semantic distinction between:

- roads that share an OSM node and therefore may connect; and
- lines that merely cross geometrically in 2D and therefore must not become a graph connection.

Bridge/tunnel/layer metadata remains available for vertical separation. Source first-node → last-node direction is preserved through splitting and clipping because `oneway`, directional lane tags and later lane placement depend on that direction.

## Turn restriction relation transport

The Rust first pass parses OSM `type=restriction` relations and retains:

- restriction relation ID;
- `restriction` value where present;
- `from` OSM way;
- target `to` OSM way;
- `via_node` or `via_way`;
- `except` mode list;
- `restriction:conditional` where present.

For each generated segment whose parent way is a restriction's `from` way, schema v3 writes a compact JSON array in `turn_restrictions`.

The browser currently enforces only **simple, unconditional via-node restrictions**. Via-way and conditional restrictions remain preserved in the road tiles and are counted as unenforced rather than being guessed or silently discarded.

## Build the generator

Requirements: a current stable Rust toolchain compatible with `road-schema/Cargo.toml`.

Run formatting and tests:

```bash
cargo fmt --manifest-path road-schema/Cargo.toml --all -- --check
cargo test --manifest-path road-schema/Cargo.toml --all-targets
```

Build static XYZ MVT plus a TileJSON document:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-xyz \
  --input data/region.osm.pbf \
  --output-dir data/game-roads \
  --tile-url-template 'https://tiles.example.com/game-roads/{z}/{x}/{y}.pbf'
```

The output directory contains `tilejson.json` plus `{z}/{x}/{y}.pbf` tiles.

Build a single PMTiles archive instead:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-pmtiles \
  --input data/region.osm.pbf \
  --output data/game-roads.pmtiles
```

CI also downloads a small real Monaco OSM PBF and requires both commands to produce non-empty real output. This complements unit tests of normalization, restriction parsing, topology IDs, MVT encoding and scratch-key ordering.

## Browser road-world assembly

The current web application consumes vector TileJSON:

```bash
VITE_GAME_ROADS_TILEJSON=https://tiles.example.com/game-roads/tilejson.json
VITE_GAME_ROADS_DEBUG=false
```

PMTiles is generated as an alternative static distribution format, but direct PMTiles loading has not yet been wired into the browser adapter.

When no TileJSON is configured, Mapshow disables simulation road surfaces rather than substituting OpenFreeMap cartographic roads.

`src/map/road-world.ts` builds a bounded topology world from loaded `game_road` source features:

1. validate schema v3;
2. group clipped features by `segment_id`;
3. stitch only direction-preserving fragment overlaps so first-node → last-node orientation survives;
4. keep multipart fallback when clipping prevents a safe merge;
5. connect graph arcs only through OSM `first_node` / `last_node` IDs;
6. apply `oneway` to directed graph arcs;
7. keep access/private/no-access metadata on physical road geometry for routing policy;
8. enforce a 650 m / 240-segment local-world budget.

The runtime starts at map zoom 14.5.

## Elevation profile

`src/map/road-profile.ts` provides a reusable metric elevation profile for rendering and later physics.

```text
centerline
   │
   ├─ densify to about 8 m samples
   ├─ query DEM
   ├─ smooth local height noise
   ├─ constrain grade by road class
   └─ ease bridge/tunnel vertical offsets near mixed-mode endpoints
            │
            ▼
      reusable road profile
```

Ground roads remain terrain-following rather than becoming flat ribbons. Major road classes receive tighter grade limits than tracks/local roads. Bridge/tunnel segments use stronger smoothing plus eased transitions when they meet ground-road segments.

Bridge deck and tunnel-floor heights remain **heuristic** because normal OSM data does not consistently include surveyed vertical geometry. The profile is world-generation input, not engineering survey output.

## Intersections, lanes and legal turns

`src/map/road-intersections.ts` creates approach-shaped junction polygons from incident segment headings and physical widths.

`src/map/road-lanes.ts` turns each topology segment into directed logical lanes. Lane-count priority is:

```text
explicit lanes / lanes:forward / lanes:backward
                     ↓
             deterministic split
                     ↓
      width-based inference only if absent
```

For a one-lane two-way road, Mapshow creates two directed logical lanes sharing one physical center path. For multilane roads, lane centers are offset laterally within `width_m`.

Traffic side is explicit rather than assumed globally. Adelaide, Hong Kong and Tokyo presets select left-hand traffic; Manhattan selects right-hand traffic; the UI allows manual switching for arbitrary locations.

The lane network first creates geometric candidate incoming → outgoing connections at shared graph nodes. It then filters those candidates in two policy passes:

1. `turn:lanes:forward` / `turn:lanes:backward`, or `turn:lanes` on one-way roads, are mapped left-to-right in the direction of travel and restrict each lane to the indicated left/through/right movements;
2. simple unconditional OSM `no_*` and `only_*` via-node restriction relations filter connections by parent `osm_id` and the shared `via_node`.

`except=motorcar`, `except=motor_vehicle`, or `except=vehicle` makes a restriction non-applicable to the generic car policy. Conditional and via-way restrictions are preserved but not yet enforced. The runtime reports candidate count, legal count, turn-lane filtering, relation filtering and preserved-but-unenforced restriction count separately.

`change:lanes*` is preserved in schema v3 for a later lane-change policy stage; it does not yet alter routing.

## Surface renderer and collision world

`src/map/road-surface-layer.ts` produces related products from the same local road profile:

```text
road profile + width_m ──> carriageway triangle strips
lane layout            ──> thin lane-center guide strips
shared graph nodes     ──> approach-shaped intersection polygons
same profiles          ──> simplified collision triangle bodies
```

`src/map/road-collision.ts` defines the renderer-independent collision contract. Segment collision centerlines are simplified to roughly 12 m spacing before strip generation; junction collision bodies reuse the prepared intersection polygon. Each body retains a Mercator origin, meter scale, indices/positions and relevant surface/vertical metadata.

The collision world deliberately does **not** choose a physics engine. It is the adapter boundary that a later Rapier/Jolt/Bullet-style integration can consume without rebuilding road topology or depending on Three.js scene objects.

## Scope boundary before vehicle dynamics

The road world now has topology segments, smoothed vertical profiles, intersection surfaces, directed lanes, turn-lane semantics, enforceable simple turn restrictions, legal lane connectivity and dedicated simplified collision meshes.

Still pending before/alongside a full vehicle controller:

- via-way and conditional turn restrictions;
- signal phases and jurisdiction-specific rules;
- `change:lanes*` lane-change legality;
- player-centered floating origin shared with physics;
- lane-following/routing interfaces;
- physics-engine adapter and suspension/tire/vehicle behavior.
