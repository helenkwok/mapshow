# Architecture

Mapshow is being built as a set of replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap data into immutable tiles rather than query Overpass for every player movement.
2. **Do not confuse cartography with simulation.** OpenMapTiles is excellent for visual context but deliberately normalises or omits attributes needed for driving physics.
3. **Keep terrain independent from vector maps.** Elevation is a separate data product with its own provider interface.
4. **Generate detail near the viewer.** Expensive building detail and collision should be generated only where it matters.
5. **Bound every expensive layer.** Dense cities must degrade to cheaper LODs rather than allowing unbounded geometry or GPU allocations.
6. **Preserve provenance.** Data licences and attribution remain separate from Mapshow's Apache-2.0 code licence.

## Visual map, terrain and building pipeline

```text
OpenFreeMap style + MVT ───────────────┐
                                       ▼
                              MapLibre GL JS
                                       │
AWS/Tilezen Terrarium DEM ─ raster-dem ┤
                                       ├─ 3D terrain + hillshade
                                       ├─ roads / water / land use / labels
                                       └─ OpenMapTiles building features
                                                │
                                                ├─ LOD1 massing
                                                ├─ LOD2 façade bands/patterns
                                                └─ LOD3 nearby geometry
                                                        │
                                                        ▼
                                                 Three.js custom layer
```

`src/map/terrain.ts` owns the elevation provider boundary. The first provider is the public AWS Open Data `elevation-tiles-prod` Terrarium dataset. MapLibre decodes the raster DEM, produces the terrain surface and hillshade, and exposes sampled elevation through `queryTerrainElevation()`.

The provider boundary is intentionally small so the default terrain can later be replaced by a self-hosted Copernicus GLO-30 product, a regional LiDAR/DTM source, or a stitched hierarchy without changing building/road code.

## Terrain-aware custom geometry

MapLibre style layers automatically participate in terrain rendering, but arbitrary Three.js custom geometry does not automatically acquire the ground elevation underneath it. Mapshow therefore explicitly samples DEM elevation for each streamed LOD3 building.

```text
building footprint center
          │
          ▼
queryTerrainElevation()
          │
          ▼
ground elevation (m)
          │
          ▼
MercatorCoordinate.fromLngLat(center, elevation)
          │
          ▼
Three.js group Z origin
```

As terrain tiles finish loading, the LOD3 stream refreshes on map `idle`. Existing building groups keep their geometry buffers but their Mercator Z position is updated when a more complete terrain sample becomes available. Turning terrain off moves custom building detail back to the zero-elevation baseline without rebuilding the façade geometry.

## Building pipeline

`src/map/buildings.ts` discovers an OpenMapTiles vector source with `source-layer: building`. If it is available, Mapshow hides the style-provided building extrusion and installs its own managed LOD layers. If no usable building source can be found, Mapshow falls back to the style-provided extrusion.

LOD2 splits each building vertically into a ground/storefront band, a main façade body and a roof cap. Runtime-generated patterns provide brick, masonry and glass/window treatments without downloading façade imagery.

LOD3 is split into three responsibilities:

- `src/map/building-feature.ts` extracts/deduplicates a real rendered footprint, derives a stable key, computes camera distance and carries sampled ground elevation.
- `src/map/building-detail-layer.ts` owns Three.js geometry, terrain anchoring, caching and disposal.
- `src/main.ts` owns the current streaming policy and budgets.

## LOD3 streaming policy

Current policy:

```text
minimum zoom              16.1
camera detail radius      260 m
maximum active buildings  24
maximum windows/building  96
maximum bays/edge          8
maximum detailed floors   10
```

The viewport's rendered `building` features are converted into candidates. Duplicate appearances of the same source/geometry are collapsed by a stable feature key. Candidates outside the metric radius are discarded, the remainder are sorted nearest-first, and only the first 24 are sent to the Three.js layer.

LOD2 remains visible underneath/outside this budget. A dense Manhattan or Hong Kong view therefore falls back to patterned extrusions instead of trying to generate detailed geometry for every visible building.

### Incremental lifecycle

`BuildingDetailLayer.setBuildings()` performs a keyed diff. Unchanged building groups stay in the Three.js scene and retain their GPU buffers. Removed groups traverse their meshes and dispose `BufferGeometry` immediately. Existing groups can update terrain Z without recreating their geometry. Shared materials remain owned by the custom layer and are disposed only when the layer itself is removed.

## Procedural building geometry

MGame demonstrates a useful design direction: OSM footprints can be the structural input to buildings that are much richer than boxes. Mapshow implements this independently.

```text
footprint + tags
      │
      ├─ building profile / height inference
      ├─ LOD1 massing
      ├─ LOD2 MapLibre façade representation
      └─ LOD3 Three.js geometry
           ├─ repeated window bays
           ├─ separate window panes + frames
           ├─ generated entrance
           └─ roof generator
                ├─ hipped roof for simple convex low-rise footprints
                └─ flat roof + parapet fallback
```

Each LOD3 building uses local meter geometry and receives its own Mercator position/scale transform. This keeps vertex coordinates small and establishes the same coordinate boundary later needed by physics and floating-origin world streaming.

## Game-road tile profile

The next major data layer should be a custom Planetiler profile. Unlike the visual OpenMapTiles transportation layer, it should retain data required to reconstruct topology and driving surfaces:

- stable OSM way/node identifiers;
- `highway` and service class;
- `lanes` and lane direction hints;
- `maxspeed`;
- explicit/derived `width`;
- `surface` and `smoothness`;
- `oneway`;
- `junction`;
- `bridge`, `tunnel`, `layer`;
- access restrictions;
- enough node connectivity information to stitch a graph across tile boundaries.

The output can remain MVT if the schema is carefully defined. Visual tiles and game-road tiles should be independently versioned.

## Terrain refinement

The current AWS Terrain Tiles source is a multi-source global dataset, not a direct Copernicus GLO-30 service. A later terrain pipeline can ingest Copernicus GLO-30 Cloud Optimized GeoTIFFs and higher-resolution regional sources, normalise them into a consistent Terrain-RGB/Terrarium or other browser-friendly representation, and publish them behind the existing provider boundary.

For driving/world simulation the terrain pipeline will eventually need more than visual relief:

1. stable terrain sampling independent of render state;
2. road-to-terrain reconciliation;
3. bridge/tunnel vertical separation;
4. tile-edge stitching;
5. collision meshes near the player;
6. source-resolution metadata so regional high-resolution DEMs can override the global base safely.

## Three.js/world layer

MapLibre remains responsible for the geographic map and large-scale visual context. Three.js is used only for game-specific geometry that requires real metric dimensions rather than style-layer decoration.

The building streamer is intentionally still main-thread and viewport-driven. Future world-streaming work should move expensive candidate preparation/mesh generation toward workers, add frame-time-aware budgets, and eventually use a player/floating-origin coordinate system shared with terrain, roads and physics.

## Near-term acceptance criteria

Before adding vehicle physics, Mapshow should be able to:

- navigate arbitrary OpenFreeMap-covered locations;
- identify and inspect buildings from vector tiles;
- transition from LOD1 massing to LOD2 procedural façades;
- generate metric LOD3 façade and roof geometry from real building footprints; *(implemented)*
- automatically stream LOD3 for a bounded set of nearby buildings; *(implemented)*
- dispose geometry as buildings leave the detail radius; *(implemented)*
- ingest and render a real DEM tile provider; *(implemented)*
- anchor custom LOD3 geometry to sampled DEM elevation; *(implemented)*
- display game-road geometry correctly across tile boundaries;
- distinguish ground roads, bridges and tunnels;
- move expensive world-generation work off the main thread where practical.
