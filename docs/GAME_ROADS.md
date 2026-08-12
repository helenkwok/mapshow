# Game-road tiles

Mapshow keeps **visual map tiles** and **simulation road tiles** separate.

OpenFreeMap/OpenMapTiles remains the visual basemap. The `road-schema/` module builds a second MVT tileset from OpenStreetMap using Planetiler, retaining attributes that a driving/world engine needs and that a cartographic schema may normalize or omit.

## Output contract

- Vector layer: `game_road`
- Zoom range: 12–16
- Geometry: source OSM road-way line geometry, with Planetiler simplification disabled for this profile
- Source-way identity is preserved; Mapshow does not merge different OSM ways in post-processing
- Machine-readable property contract: [`../road-schema/schema.json`](../road-schema/schema.json)

Important fields include:

| Field | Purpose |
| --- | --- |
| `osm_id` | Stable source OSM way ID |
| `highway` / `road_class` | Raw and normalized road class |
| `lanes`, directional lanes | Lane hints when explicitly parseable |
| `maxspeed_raw`, `speed_kmh` | Raw speed tag plus numeric km/h when parseable |
| `width_raw`, `width_m`, `width_source` | Explicit or estimated carriageway width with provenance |
| `surface`, `surface_class`, `smoothness`, `tracktype` | Surface/ride-quality inputs |
| `oneway` | `-1`, `0`, or `1` normalized travel direction |
| `bridge`, `tunnel`, `layer` | Vertical separation inputs |
| `access`, `vehicle`, `motor_vehicle` | Access restrictions retained for the simulation layer |
| `first_node`, `last_node`, `node_count` | Source-way endpoint topology metadata |

`speed_kmh` is intentionally **not guessed** when OSM lacks a parseable `maxspeed`. Legal defaults vary by jurisdiction and should not be silently invented by the tile generator.

`width_m` may be estimated because a driveable mesh needs a physical width. `width_source` always records whether the value came from an explicit OSM width tag, lane count, or a class fallback.

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

Planetiler v0.10.2 is pinned because the profile is compiled against a known API and that release supports output through zoom 16.

## Serve to the browser

Mapshow's browser adapter accepts a TileJSON URL independently of OpenFreeMap:

```bash
VITE_GAME_ROADS_TILEJSON=http://localhost:8080/data/game-roads.json
VITE_GAME_ROADS_DEBUG=true
```

The optional debug layer exists only to validate generated road tiles. Production road surfaces and collision should be generated in the game/world layer, not by styling the debug line.

## Topology boundary

This first schema preserves the source way ID, endpoint node IDs, node count, high-detail line geometry, and vertical-separation tags. It deliberately does not claim to be a complete routing graph.

OSM ways can pass through several shared internal nodes, so `first_node`/`last_node` alone cannot encode every intersection. The next road-world stage should build segment/intersection topology from the decoded line geometry and/or a dedicated graph sidecar derived directly from OSM node references. Keeping stable `osm_id` values and avoiding cross-way merges ensures that later graph can still be traced back to source data.

## Intended browser/world flow

```text
OSM planet / regional PBF
        │
        ▼
Planetiler MapshowRoadProfile
        │
        ▼
 game_road MVT tiles
        │
        ├─ stable road identity
        ├─ dimensions / lanes / surface
        ├─ access + direction
        └─ bridge / tunnel / layer
        │
        ▼
 browser road decoder
        │
        ▼
local metric road graph + surface generator
        │
        ├─ visual mesh
        └─ collision / vehicle physics
```
