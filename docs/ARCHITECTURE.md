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
                  └─ LOD2 procedural façade bands/patterns
```

`src/map/buildings.ts` discovers an OpenMapTiles vector source with `source-layer: building`. If it is available, Mapshow hides the style-provided building extrusion and installs its own managed LOD layers. If no usable building source can be found, Mapshow falls back to the style-provided extrusion.

The close-detail LOD currently splits each building vertically into a ground/storefront band, a main façade body and a roof cap. Runtime-generated texture patterns provide brick, masonry and glass/window treatments without adding another renderer or downloading façade imagery.

This is deliberately not the final building system. Patterned map extrusions are the LOD2 bridge between plain boxes and true procedural geometry.

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
      ├─ massing / floor-height inference
      ├─ vertical segmentation
      │    ├─ socle/base
      │    ├─ entrance/storefront level
      │    ├─ repeated façade floors
      │    └─ parapet/roof transition
      ├─ façade system
      │    ├─ generated LOD2 patterns       ← current
      │    └─ LOD3 bay/window geometry      ← next
      ├─ roof generator
      └─ optional custom landmark model
```

`src/map/building-profile.ts` owns deterministic height and façade-family inference. `src/map/building-patterns.ts` generates the current façade textures at runtime. The same building inputs therefore lead to the same profile without relying on commercial imagery.

### Detail levels

- **LOD 0:** footprint only or hidden.
- **LOD 1:** simple extrusion for medium-distance context.
- **LOD 2:** vertically segmented extrusion with generated façade/window/material patterns. *(implemented)*
- **LOD 3:** near-camera procedural façade bays, entrances and roof geometry.
- **Collision:** separate low-complexity mesh, generated only within an interaction radius.

The LOD2 patterns are screen/style textures rather than metric façade geometry. LOD3 should move the close-range representation into a geometry-capable layer so windows, doors, balconies and roof forms have real dimensions.

## Stage 5 — Three.js/world layer

MapLibre should remain responsible for the geographic map and large-scale visual context. A Three.js custom layer or coordinated renderer can handle game-specific geometry, effects, vehicles and physics.

Keep map coordinates out of the physics engine. Convert nearby geographic coordinates into a local metric frame and shift the origin as the player moves to avoid floating-point precision loss.

## Near-term acceptance criteria

Before adding vehicle physics, Mapshow should be able to:

- navigate arbitrary OpenFreeMap-covered locations;
- identify and inspect buildings from vector tiles;
- transition from LOD1 massing to LOD2 procedural façades;
- replace LOD2 with true near-camera building geometry without changing the map-data adapter;
- ingest one real DEM tile provider;
- display roads correctly across tile boundaries;
- distinguish ground roads, bridges and tunnels;
- unload distant generated geometry without leaking GPU memory.
