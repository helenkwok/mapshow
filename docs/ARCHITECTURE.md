# Architecture

Mapshow is being built as a set of replaceable data and world-generation adapters rather than a monolithic map renderer.

## Principles

1. **Keep global map delivery cheap.** Preprocess OpenStreetMap data into immutable tiles rather than query Overpass for every player movement.
2. **Do not confuse cartography with simulation.** OpenMapTiles is excellent for visual context but deliberately normalises or omits attributes needed for driving physics.
3. **Keep terrain independent from vector maps.** Elevation is a separate data product and should have its own provider/cache interface.
4. **Generate detail near the viewer.** Expensive building detail and collision should be generated only where it matters.
5. **Preserve provenance.** Data licences and attribution remain separate from Mapshow's Apache-2.0 code licence.

## Stage 1 — visual map foundation

```text
OpenFreeMap style + MVT
          │
          ▼
      MapLibre GL JS
          │
          ├─ roads / water / land use / labels
          └─ building layer
                  │
                  ├─ LOD1 massing
                  ├─ LOD2 façade bands/patterns
                  └─ LOD3 selected-building geometry → Three.js custom layer
```

`src/map/buildings.ts` discovers an OpenMapTiles vector source with `source-layer: building`. If it is available, Mapshow hides the style-provided building extrusion and installs its own managed LOD layers. If no usable building source can be found, Mapshow falls back to the style-provided extrusion.

LOD2 splits each building vertically into a ground/storefront band, a main façade body and a roof cap. Runtime-generated texture patterns provide brick, masonry and glass/window treatments without downloading façade imagery.

LOD3 is implemented in `src/map/selected-building-layer.ts`. A clicked vector-tile building supplies the actual polygon footprint and derived building profile. The footprint is converted from geographic coordinates into a local metric frame, detailed geometry is generated in meters, and a Three.js custom layer transforms the result back into MapLibre's Mercator world for rendering with the map's shared WebGL context.

## Stage 2 — game-road tile profile

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

## Stage 3 — elevation

Define an elevation-provider interface before choosing one physical encoding. Candidate inputs include Copernicus DEM and higher-resolution regional open elevation sources where licensing permits.

The browser-side terrain worker should:

1. fetch/decode elevation tiles;
2. generate a local terrain mesh;
3. stitch edges against neighbouring tiles;
4. drape or reconcile road geometry with terrain;
5. keep bridges/tunnels on separate vertical layers;
6. generate simplified collision geometry near the player only.

## Stage 4 — procedural buildings

MGame demonstrates a useful design direction: OSM footprints can be the structural input to buildings that are much richer than boxes. Mapshow implements this independently in progressive levels of detail.

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

`src/map/building-profile.ts` owns deterministic height and façade-family inference. `src/map/building-patterns.ts` generates LOD2 façade textures at runtime. `src/map/selected-building-layer.ts` owns the first geometry-capable LOD3 implementation.

### Detail levels

- **LOD 0:** footprint only or hidden.
- **LOD 1:** simple extrusion for medium-distance context. *(implemented)*
- **LOD 2:** vertically segmented extrusion with generated façade/window/material patterns. *(implemented)*
- **LOD 3:** metric façade-window, entrance and roof geometry for the selected building. *(implemented foundation)*
- **LOD 3 streaming:** generate and retire LOD3 geometry automatically for a bounded set of nearby buildings. *(next building milestone)*
- **Collision:** separate low-complexity mesh, generated only within an interaction radius.

The current LOD3 intentionally processes one selected building. This keeps the proof of concept bounded while validating the coordinate transforms, geometry generation, shared WebGL renderer, GPU cleanup and real-vector-footprint workflow before multi-building streaming is introduced.

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
local-meter → Mercator model matrix
             │
             ▼
MapLibre modelViewProjectionMatrix
             │
             ▼
shared WebGL framebuffer
```

Keeping procedural geometry local avoids building meshes directly from large world coordinates and establishes the same coordinate boundary later needed by physics and floating-origin world streaming.

## Stage 5 — Three.js/world layer

MapLibre remains responsible for the geographic map and large-scale visual context. Three.js is introduced only for game-specific geometry that requires real metric dimensions rather than style-layer decoration.

The next world-layer step is to move from selection-driven LOD3 to a bounded near-camera building set with explicit geometry budgets. Generated meshes must be removed and their GPU buffers disposed as buildings leave the detail radius.

Keep global map coordinates out of the physics engine. Convert nearby geographic coordinates into a local metric frame and shift the origin as the player moves to avoid floating-point precision loss.

## Near-term acceptance criteria

Before adding vehicle physics, Mapshow should be able to:

- navigate arbitrary OpenFreeMap-covered locations;
- identify and inspect buildings from vector tiles;
- transition from LOD1 massing to LOD2 procedural façades;
- generate LOD3 façade and roof geometry from a real selected building footprint; *(implemented)*
- automatically stream LOD3 for a bounded set of nearby buildings;
- ingest one real DEM tile provider;
- display roads correctly across tile boundaries;
- distinguish ground roads, bridges and tunnels;
- unload distant generated geometry without leaking GPU memory.
