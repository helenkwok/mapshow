# Game-road tiles

Mapshow keeps **visual map tiles** and **simulation road tiles** separate.

OpenFreeMap/OpenMapTiles remains the visual basemap. The `road-schema/` module builds a second MVT tileset from OpenStreetMap using Planetiler, retaining attributes that a driving/world engine needs and that a cartographic schema may normalize or omit.

## Output contract — schema v3

- Vector layer: `game_road`
- Zoom range: 12–16
- Geometry: OSM road lines split by Planetiler at shared OSM intersection nodes
- Source-way identity remains available through `osm_id`
- Each intersection-to-intersection piece has a unique `segment_id`
- Geometry simplification/minimum-size filtering is disabled for this simulation profile
- Different OSM roads are not merged in tile post-processing
- Machine-readable property contract: [`../road-schema/schema.json`](../road-schema/schema.json)

Important fields include `segment_id`, `osm_id`, road class, total/directional lanes, tagged speeds, `width_m` with provenance, surface/ride metadata, `oneway`, bridge/tunnel/layer, access restrictions, first/last OSM node IDs, raw `turn:lanes*` / `change:lanes*` strings, and compact turn-restriction relation metadata.

`speed_kmh` is intentionally **not guessed** when OSM lacks a parseable `maxspeed`. `width_m` may be estimated because a driveable mesh needs a physical width; `width_source` records whether it came from an explicit width tag, lane count, or class fallback.

## Turn restriction relation transport

Planetiler's first OSM pass exposes `Profile.preprocessOsmRelation()`. Mapshow retains `type=restriction` relations in a compact `OsmRelationInfo` record and receives those relation memberships again while processing member ways.

For road segments whose parent OSM way has role `from`, schema v3 writes a compact JSON array in `turn_restrictions` containing:

- restriction relation ID;
- `restriction` value where present;
- target `to` OSM way ID;
- `via_node` or `via_way`;
- `except` mode list;
- `restriction:conditional` where present.

The browser currently enforces only **simple, unconditional via-node restrictions**. Via-way and conditional restrictions remain preserved in the road tiles and are counted as unenforced rather than being guessed or silently discarded.

## Why the generator splits ways before tiling

Planetiler provides `Profile.splitOsmWayAtIntersections()` and `FeatureCollector.splitLine()`. Mapshow opts supported road ways into that mechanism, so internal shared OSM nodes become explicit topology-segment endpoints before MVT clipping.

Two roads that only cross geometrically are therefore not connected accidentally. They connect only when the OSM topology says they share a node; bridge/tunnel/layer metadata remains available for vertical separation.

## Build and serve the generator

Requirements: Java 21 and Maven 3.9+.

```bash
mvn -B -f road-schema/pom.xml verify
```

Generate a regional extract or supply an existing PBF, then serve the resulting MBTiles with a vector-tile server. Mapshow accepts the independent TileJSON through:

```bash
VITE_GAME_ROADS_TILEJSON=http://localhost:8080/data/game-roads.json
VITE_GAME_ROADS_DEBUG=false
```

When no TileJSON is configured, Mapshow disables simulation road surfaces rather than substituting OpenFreeMap cartographic roads.

## Browser road-world assembly

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

Bridge deck and tunnel-floor heights remain **heuristic** because normal OSM data does not consistently include surveyed vertical geometry. The profile is therefore world-generation input, not engineering survey output.

## Intersection polygons

`src/map/road-intersections.ts` creates approach-shaped junction polygons from incident segment headings and physical widths. Junction vertices inherit nearby road-profile elevations while the center is anchored to a shared node elevation.

This is intentionally simpler than a lane-marking/signal-engineering model; medians, channelized islands, slip lanes and complex divided intersections need richer semantics later.

## Lane centerlines, traffic side and legal turns

`src/map/road-lanes.ts` turns each topology segment into directed logical lanes.

Lane-count priority is:

```text
explicit lanes / lanes:forward / lanes:backward
                     ↓
             deterministic split
                     ↓
      width-based inference only if absent
```

For a one-lane two-way road, Mapshow creates two directed logical lanes sharing one physical center path. For multilane roads, lane centers are offset laterally within `width_m`.

Lateral placement explicitly depends on traffic side. Mapshow does **not** assume right-hand traffic globally:

- Adelaide, Hong Kong and Tokyo presets select left-hand traffic;
- Manhattan selects right-hand traffic;
- the UI allows manual switching for arbitrary locations.

The lane network first creates geometric candidate incoming → outgoing connections at shared graph nodes. It then filters those candidates in two policy passes:

1. `turn:lanes:forward` / `turn:lanes:backward`, or `turn:lanes` on one-way roads, are mapped left-to-right in the direction of travel and restrict each lane to the indicated left/through/right movements;
2. simple unconditional OSM `no_*` and `only_*` via-node restriction relations filter connections by parent `osm_id` and the shared `via_node`.

`except=motorcar`, `except=motor_vehicle`, or `except=vehicle` makes a restriction non-applicable to the generic car policy. Conditional and via-way restrictions are preserved but not yet enforced. The runtime reports candidate count, legal count, turn-lane filtering, relation filtering and preserved-but-unenforced restriction count separately.

`change:lanes*` is preserved in schema v3 for a later lane-change policy stage; it does not yet alter routing.

## Surface renderer and collision world

`src/map/road-surface-layer.ts` now produces four related products from the same local road profile:

```text
road profile + width_m ──> carriageway triangle strips
lane layout            ──> thin lane-center guide strips
shared graph nodes     ──> approach-shaped intersection polygons
same profiles          ──> simplified collision triangle bodies
```

`src/map/road-collision.ts` defines the renderer-independent collision contract. Segment collision centerlines are simplified to roughly 12 m spacing before strip generation; junction collision bodies reuse the already prepared intersection polygon. Each body retains a Mercator origin, meter scale, indices/positions and relevant surface/vertical metadata.

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
