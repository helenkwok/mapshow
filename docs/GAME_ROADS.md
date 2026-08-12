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

Important fields include:

| Field | Purpose |
| --- | --- |
| `segment_id` | Stable per-build identity for an intersection-to-intersection segment |
| `osm_id` | Parent OSM way ID |
| `highway` / `road_class` | Raw and normalized road class |
| `lanes`, directional lanes | Lane hints when explicitly parseable |
| `maxspeed_raw`, `speed_kmh` | Raw speed tag plus numeric km/h when parseable |
| `width_raw`, `width_m`, `width_source` | Explicit or estimated carriageway width with provenance |
| `surface`, `surface_class`, `smoothness`, `tracktype` | Surface/ride-quality inputs |
| `oneway` | `-1`, `0`, or `1` normalized travel direction |
| `bridge`, `tunnel`, `layer` | Vertical separation inputs |
| `access`, `vehicle`, `motor_vehicle` | Access restrictions retained for simulation |
| `first_node`, `last_node`, `node_count` | Segment endpoint topology and retained source-vertex count |

`speed_kmh` is intentionally **not guessed** when OSM lacks a parseable `maxspeed`. Legal defaults vary by jurisdiction and should not be silently invented by the tile generator.

`width_m` may be estimated because a driveable mesh needs a physical width. `width_source` records whether the value came from an explicit OSM width tag, lane count, or class fallback.

## Why the generator splits ways before tiling

Planetiler provides `Profile.splitOsmWayAtIntersections()` and `FeatureCollector.splitLine()`. Mapshow opts every supported motor road into that mechanism. A source way such as:

```text
node A ─ node B ─ node C ─ node D
                 │
                 └──── another road
```

is emitted as separate topology segments at the shared node rather than relying on the browser to infer that internal junction from clipped vector-tile geometry.

This is also how grade separation remains safe: two lines that merely cross geometrically are **not** connected unless OSM actually gives them a shared node. `bridge`, `tunnel`, and `layer` remain available for vertical placement.

## Build the generator

Requirements:

- Java 21
- Maven 3.9+

Compile and test:

```bash
mvn -B -f road-schema/pom.xml verify
```

Generate a small Geofabrik extract such as Monaco:

```bash
java -jar road-schema/target/mapshow-road-schema-0.1.0-jar-with-dependencies.jar \
  --area=monaco \
  --download
```

Or supply an existing `.osm.pbf`:

```bash
java -jar road-schema/target/mapshow-road-schema-0.1.0-jar-with-dependencies.jar \
  --osm_path=/data/adelaide.osm.pbf \
  --output=/data/game-roads.mbtiles
```

Planetiler v0.10.2 is pinned because the profile is compiled against a known released API and that release supports output through zoom 16.

## Serve to the browser

Serve the generated MBTiles through a vector-tile server and provide its TileJSON independently of OpenFreeMap:

```bash
VITE_GAME_ROADS_TILEJSON=http://localhost:8080/data/game-roads.json
VITE_GAME_ROADS_DEBUG=false
```

When no TileJSON is configured, Mapshow disables the road-surface control rather than using OpenFreeMap cartographic roads as fake simulation data.

## Browser road-world assembly

`src/map/road-world.ts` consumes loaded `game_road` source features and creates a bounded local graph:

1. reject incompatible schema versions and motor-vehicle-inaccessible segments;
2. group duplicate/clipped tile features by `segment_id`;
3. stitch identical/overlapping line fragments where endpoint/sequence overlap is available;
4. retain multipart fragments when clipping prevents a safe merge—the source tile buffer prevents visible cracks;
5. connect graph edges only through `first_node` / `last_node` OSM IDs;
6. apply `oneway` to produce directed graph arcs;
7. rank nearby segments and enforce the world-streaming budget.

The current runtime budget is:

```text
minimum map zoom        14.5
road-world radius       650 m
maximum active segments 240
DEM sample spacing      ~8 m
```

## Driveable surface representation

`src/map/road-surface-layer.ts` turns active graph segments into Three.js metric carriageway strips:

```text
game_road centerline + width_m
              │
              ├─ densify to DEM sampling interval
              ├─ query terrain elevation
              ├─ calculate local perpendiculars
              └─ offset left/right by width / 2
                          │
                          ▼
                 triangle-strip road mesh
```

Shared graph nodes with two or more incident segments receive a small junction pad to cover the centerline-strip meeting area. The generated geometry carries `segment_id`, `osm_id`, endpoint node IDs, width and one-way metadata in Three.js `userData`, establishing the boundary needed by a later collision/vehicle layer.

### Terrain and grade separation

Ground roads follow sampled MapLibre DEM elevation with a small lift to avoid z-fighting.

Bridge and tunnel heights are **provisional visual heuristics**, because ordinary OSM road data usually does not contain surveyed deck or tunnel-floor elevation. The current renderer applies minimum bridge clearance / tunnel depth plus OSM `layer` separation. This prevents obvious ground/bridge crossings from collapsing into one plane, but it is not yet engineering-grade vertical geometry.

A later road-refinement stage should use explicit elevation tags where available, interpolate bridge approaches, reconcile road grades across several graph segments, and generate tunnel/bridge structures separately.

## Current scope boundary

The road world is now topology-aware and produces a visual driveable surface, but it is **not yet a vehicle-physics system**. Remaining work includes:

- robust intersection polygon generation rather than circular junction pads;
- road-grade smoothing and bridge approach continuity;
- lane-centerline generation;
- collision meshes / physics bodies;
- turn restrictions and route relations;
- floating-origin road streaming tied to a moving player;
- vehicle controller and suspension/tire interaction.
