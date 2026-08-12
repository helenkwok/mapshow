# Game-road tiles

Mapshow keeps **visual map tiles** and **simulation road tiles** separate.

OpenFreeMap/OpenMapTiles remains the visual basemap. The `road-schema/` module builds a second MVT tileset from OpenStreetMap using Planetiler, retaining attributes that a driving/world engine needs and that a cartographic schema may normalize or omit.

## Output contract — schema v2

- Vector layer: `game_road`
- Zoom range: 12–16
- Geometry: OSM road lines split by Planetiler at shared OSM intersection nodes
- Source-way identity remains available through `osm_id`
- Each intersection-to-intersection piece has a unique `segment_id`
- Geometry simplification/minimum-size filtering is disabled for this simulation profile
- Different OSM roads are not merged in tile post-processing
- Machine-readable property contract: [`../road-schema/schema.json`](../road-schema/schema.json)

Important fields include `segment_id`, `osm_id`, road class, total/directional lanes, tagged speeds, `width_m` with provenance, surface/ride metadata, `oneway`, bridge/tunnel/layer, access restrictions, and first/last OSM node IDs.

`speed_kmh` is intentionally **not guessed** when OSM lacks a parseable `maxspeed`. `width_m` may be estimated because a driveable mesh needs a physical width; `width_source` records whether it came from an explicit width tag, lane count, or class fallback.

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

1. validate schema v2;
2. group clipped features by `segment_id`;
3. stitch only direction-preserving fragment overlaps so first-node → last-node orientation survives;
4. keep multipart fallback when clipping prevents a safe merge;
5. connect graph arcs only through OSM `first_node` / `last_node` IDs;
6. apply `oneway` to directed graph arcs;
7. keep access/private/no-access metadata on physical road geometry for the later routing-policy layer;
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

The previous circular junction pad has been replaced by `src/map/road-intersections.ts`.

For every graph node with multiple incident segments, Mapshow walks a short distance into each approach, offsets by that road's half-width, collects the approach throat boundaries, and builds a convex junction footprint. Junction vertices inherit nearby road-profile elevations while the center is anchored to a shared node elevation.

This produces junction geometry based on real road widths and headings instead of an arbitrary radius. It is still intentionally simpler than a lane-marking/signal-engineering model; medians, channelized islands, slip lanes and complex divided intersections need richer source semantics later.

## Lane centerlines and traffic side

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

The lane network also creates **candidate** incoming → outgoing lane connections at shared graph nodes. These connections exclude implicit U-turns and classify straight/left/right movement from approach headings.

They are not yet legal turn routing. `turn:lanes`, OSM restriction relations, signals, lane-change rules and jurisdiction-specific lane discipline still need their own policy stage.

## Surface renderer

`src/map/road-surface-layer.ts` now renders three related products from the same local road profile:

```text
road profile + width_m ──> carriageway triangle strips
lane layout            ──> thin lane-center guide strips
shared graph nodes     ──> approach-shaped intersection polygons
```

The geometry remains bounded/cached, with stale `BufferGeometry` disposed as road segments leave the local world.

## Scope boundary before physics

The road world now has topology segments, smoothed vertical profiles, intersection surfaces, directed lane centerlines and candidate lane connectivity. It still does **not** claim final driving legality or vehicle dynamics.

The next physics-oriented work should add turn restrictions/turn-lane semantics, dedicated collision meshes, player-centered floating origin, lane-following/routing interfaces, and then suspension/tire/vehicle-controller behavior.
