# Architecture

Mapshow is being built as a set of replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap data into immutable tiles rather than query Overpass for every player movement.
2. **Do not confuse cartography with simulation.** OpenMapTiles is excellent for visual context but deliberately normalises or omits attributes needed for driving physics.
3. **Keep terrain independent from vector maps.** Elevation is a separate data product and should have its own provider/cache interface.
4. **Generate detail near the viewer.** Expensive building detail and collision should be generated only where it matters.
5. **Bound every expensive layer.** Dense cities must degrade to cheaper LODs rather than allowing unbounded geometry or GPU allocations.
6. **Preserve provenance.** Data licences and attribution remain separate from Mapshow's Apache-2.0 code licence.

## Visual map and building pipeline

```text
OpenFreeMap style + MVT
          │
          ▼
      MapLibre GL JS
          │
          ├─ roads / water / land use / labels
          └─ OpenMapTiles building features
                  │
                  ├─ LOD1 massing
                  ├─ LOD2 façade bands/patterns
                  └─ LOD3 nearby-building geometry → Three.js custom layer
```

`src/map/buildings.ts` discovers an OpenMapTiles vector source with `source-layer: building`. If it is available, Mapshow hides the style-provided building extrusion and installs its own managed LOD layers. If no usable building source can be found, Mapshow falls back to the style-provided extrusion.

LOD2 splits each building vertically into a ground/storefront band, a main façade body and a roof cap. Runtime-generated patterns provide brick, masonry and glass/window treatments without downloading façade imagery.

LOD3 is now split into three responsibilities:

- `src/map/building-feature.ts` extracts/deduplicates a real rendered footprint, derives a stable key and computes its camera distance.
- `src/map/building-detail-layer.ts` owns Three.js geometry, caching and disposal.
- `src/main.ts` owns the current streaming policy and budgets.

## LOD3 streaming policy

LOD3 activates only at close zoom and only for a bounded near-camera set.

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

`BuildingDetailLayer.setBuildings()` performs a keyed diff:

```text
previous active keys        desired active keys
         │                         │
         └──────── compare ────────┘
                    │
          ┌─────────┴─────────┐
          │                   │
      still active        no longer needed
      keep buffers         dispose geometry
          │
          └──────── newly desired
                    generate once
```

Unchanged building groups stay in the Three.js scene and retain their GPU buffers. Removed groups traverse their meshes and dispose `BufferGeometry` immediately. Shared materials remain owned by the custom layer and are disposed only when the layer itself is removed.

This is the first explicit GPU-memory budget in Mapshow.

## Procedural building geometry

MGame demonstrates a useful design direction: OSM footprints can be the structural input to buildings that are much richer than boxes. Mapshow implements this independently.

```text
footprint + tags
      │
      ├─ building profile / height inference
      │
      ├─ LOD1 massing
      │
      ├─ LOD2 MapLibre façade representation
      │    ├─ ground/storefront band
      │    ├─ patterned façade body
      │    └─ roof cap
      │
      └─ LOD3 Three.js geometry
           ├─ repeated window bays
           ├─ separate window panes + frames
           ├─ generated entrance
           └─ roof generator
                ├─ hipped roof for simple convex low-rise footprints
                └─ flat roof + parapet fallback
```

`src/map/building-profile.ts` owns deterministic height and façade-family inference. `src/map/building-patterns.ts` generates LOD2 façade textures at runtime. LOD3 converts each active footprint into its own local metric frame before generating geometry.

### LOD3 coordinate model

```text
OSM/OpenMapTiles polygon (lng/lat)
             │
             ▼
Mercator origin at building centroid
             │
             ▼
local meter coordinates
             │
       procedural geometry
             │
             ▼
Three.js Group position + meter scale in Mercator units
             │
             ▼
MapLibre modelViewProjectionMatrix
             │
             ▼
shared WebGL framebuffer
```

Each building group uses local meter geometry and receives its own Mercator position/scale transform. This keeps vertex coordinates small and establishes the same coordinate boundary later needed by physics and floating-origin world streaming.

## Game-road tile profile

Create a custom Planetiler profile in a separate package/service. Unlike the visual OpenMapTiles transportation layer, it should retain data required to reconstruct topology and driving surfaces:

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

## Elevation

Define an elevation-provider interface before choosing one physical encoding. Candidate inputs include Copernicus DEM and higher-resolution regional open elevation sources where licensing permits.

The browser-side terrain worker should:

1. fetch/decode elevation tiles;
2. generate a local terrain mesh;
3. stitch edges against neighbouring tiles;
4. drape or reconcile road geometry with terrain;
5. keep bridges/tunnels on separate vertical layers;
6. generate simplified collision geometry near the player only.

## Three.js/world layer

MapLibre remains responsible for the geographic map and large-scale visual context. Three.js is used only for game-specific geometry that requires real metric dimensions rather than style-layer decoration.

The building streamer is intentionally still main-thread and viewport-driven. The next world-streaming work should move expensive candidate preparation/mesh generation toward workers, add frame-time-aware budgets, and eventually use a player/floating-origin coordinate system shared with terrain, roads and physics.

## Near-term acceptance criteria

Before adding vehicle physics, Mapshow should be able to:

- navigate arbitrary OpenFreeMap-covered locations;
- identify and inspect buildings from vector tiles;
- transition from LOD1 massing to LOD2 procedural façades;
- generate metric LOD3 façade and roof geometry from real building footprints; *(implemented)*
- automatically stream LOD3 for a bounded set of nearby buildings; *(implemented)*
- dispose geometry as buildings leave the detail radius; *(implemented)*
- ingest one real DEM tile provider;
- display roads correctly across tile boundaries;
- distinguish ground roads, bridges and tunnels;
- move expensive world-generation work off the main thread where practical.
