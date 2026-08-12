# Architecture

Mapshow is built as replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap into immutable tiles rather than query Overpass while the player moves.
2. **Do not confuse cartography with simulation.** OpenMapTiles is visual context; simulation road data has a separate schema.
3. **Keep terrain independent from vector maps.** Elevation has its own provider interface.
4. **Generate detail near the viewer.** Expensive geometry and collision are bounded near the camera/player.
5. **Bound every expensive layer.** Dense cities degrade to cheaper LODs rather than growing GPU allocations without limit.
6. **Preserve provenance and identity.** OSM feature/node IDs and data licences survive preprocessing wherever the world layer needs traceability.
7. **Keep policy separate from physical geometry.** Access restrictions, turn legality and traffic rules should not decide whether a physical road exists in the world mesh.

## Data planes

```text
                        OpenStreetMap
                         /          \
                        /            \
             OpenFreeMap MVT      Mapshow game-road MVT
                 │                       │
                 │ visual               │ simulation
                 ▼                       ▼
          MapLibre basemap        local road graph
                 │                       │
AWS/Tilezen DEM ─┤                       ├─ lane network
                 ▼                       ├─ road profiles
          MapLibre terrain               └─ intersections
                 │                             │
                 ├───────────────┐             ▼
                 ▼               ▼       road surfaces
             building LODs      local Three.js world
                                         │
                                  collision / physics
```

The visual and simulation road products are intentionally independent. A future visual-style change must not modify driving geometry, and a road-physics schema change must not require rebuilding OpenFreeMap.

## Terrain and buildings

`src/map/terrain.ts` owns the elevation-provider boundary. The current provider is the AWS Open Data `elevation-tiles-prod` Terrarium dataset. MapLibre renders the terrain and exposes `queryTerrainElevation()` for custom world geometry.

Building LOD3 uses bounded Three.js geometry anchored to sampled DEM height. The current building budget is 24 buildings within 260 m at close zoom, with explicit geometry caps and disposal.

## Game-road preprocessing — schema v2

`road-schema/` uses Planetiler v0.10.2 / Java 21 to emit `game_road` MVT at zoom 12–16.

`MapshowRoadProfile.splitOsmWayAtIntersections()` and `FeatureCollector.splitLine()` split supported OSM roads at real shared OSM nodes before tiling. Each result retains:

- `segment_id`: topology-segment identity;
- `osm_id`: parent OSM way identity;
- `first_node` / `last_node`;
- total and directional lane tags;
- tagged speeds and `width_m` with provenance;
- surface/ride metadata;
- access/vehicle restrictions;
- `oneway`;
- bridge/tunnel/layer metadata.

Distinct OSM ways are never merged as a preprocessing shortcut. A geometric 2D crossing does not become a graph connection without shared OSM topology.

## Browser road-world assembly

`src/map/game-roads.ts` validates schema v2. `src/map/road-world.ts` converts loaded source features into a bounded local topology world.

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

Access/private/no-access fields stay on the physical road records. They are inputs to future routing policy, not a filter that deletes the road mesh.

Current road-world budget:

```text
minimum zoom              14.5
camera radius             650 m
maximum active segments   240
```

## Reusable road elevation profile

`src/map/road-profile.ts` creates the vertical profile reused by rendering now and physics later.

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

## Lane network

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

The lane network also creates candidate incoming → outgoing connections at graph nodes. These connections classify straight/left/right movements from approach headings and exclude implicit U-turns.

This is **not final turn legality**. `turn:lanes`, restriction relations, signals and jurisdiction-specific lane rules belong to a later policy layer.

## Intersection geometry

`src/map/road-intersections.ts` replaces the old circular junction pad.

For each shared graph node it:

1. walks a bounded distance down every active approach;
2. offsets the approach center by its actual half-width;
3. collects left/right throat boundaries;
4. builds a convex junction footprint;
5. uses nearby road-profile elevations on the approach edge;
6. anchors the center to the shared graph-node elevation.

This creates a physical intersection shape from road headings and widths rather than an arbitrary radius. It intentionally does not yet model channelized islands, medians, signal stop lines or complex divided junctions.

## Road surface renderer

`src/map/road-surface-layer.ts` consumes the graph, road profiles, lane layouts and intersection polygons.

```text
road profile + width_m ──> carriageway strips
lane layout            ──> lane-center guide strips
shared graph nodes     ──> intersection polygons
```

The same smoothed Z profile drives the carriageway and lane guides so they cannot disagree vertically. Road groups carry source IDs, endpoint IDs, lane IDs, width and direction metadata in Three.js `userData` for later collision/vehicle integration.

Geometry remains bounded and cached; stale `BufferGeometry` is disposed when segments leave the local world or a profile/lane configuration changes.

## Runtime integration

`src/main.ts` owns streaming policy and world controls. When a dedicated TileJSON is configured it:

- installs the simulation vector source;
- builds the local road graph;
- derives lane topology using the current traffic side;
- creates smoothed road profiles;
- streams carriageways/intersections/lane guides;
- refreshes as the camera or DEM changes;
- exposes traffic-side and road-surface controls plus runtime counts.

Without `VITE_GAME_ROADS_TILEJSON`, simulation road surfaces remain disabled. OpenFreeMap roads are never silently promoted to physics geometry.

## Remaining boundary before vehicle physics

Implemented now:

- real DEM terrain;
- bounded procedural building LODs;
- topology-split road MVT;
- direction-preserving tile-fragment assembly;
- directed local graph;
- smoothed/grade-limited road profiles;
- bridge/tunnel approach easing;
- approach-shaped intersection polygons;
- explicit left/right traffic;
- directed lane centerlines and candidate lane connectivity.

Still separate:

- `turn:lanes` parsing and OSM restriction relations;
- legal routing/vehicle access policy;
- signals and lane-change rules;
- dedicated simplified collision meshes/physics bodies;
- player-centric floating origin and worker-based road generation;
- vehicle suspension, tire forces and controller behavior;
- higher-resolution regional terrain/road elevation refinement.
