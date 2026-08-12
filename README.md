# Mapshow

Mapshow is an open-data browser experiment for turning global map data into a lightweight 3D world.

The project deliberately separates **map delivery** from **game/world generation**:

- [OpenFreeMap](https://openfreemap.org/) provides preprocessed OpenStreetMap-derived vector tiles.
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) renders the global map in the browser.
- Mapshow discovers the OpenMapTiles `building` layer and progressively enriches it instead of treating the source style's extrusion as the final building representation.
- Game-road geometry, DEM terrain, richer procedural buildings, collision and world streaming remain separate layers of the architecture.

This repository does **not** contain source code or assets copied from MGame or Hop.Earth. Those projects are architectural references for features we can implement independently.

## Run locally

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```

## Current prototype

The prototype provides:

- OpenFreeMap Liberty style with no API key;
- pitched 3D map navigation;
- automatic discovery of OpenMapTiles building data;
- LOD1 building massing at medium zoom;
- LOD2 procedural façade rendering at close zoom;
- separate ground/storefront, façade-body and roof-cap bands;
- generated brick, masonry and glass façade/window patterns;
- height-based deterministic façade-family selection;
- building visibility control;
- building-property and derived-profile inspection;
- presets for Adelaide, Hong Kong, Manhattan, and Tokyo;
- responsive desktop/mobile controls.

The LOD2 façade system is deliberately lightweight. Its window/material patterns are generated at runtime and rendered by MapLibre on the extrusion surfaces. It is a stepping stone toward LOD3 geometry with real façade bays, roof shapes, entrances, balconies and apparent interiors.

## Architecture direction

Mapshow should not treat cartographic tiles as physics-ready world geometry. The intended pipeline is:

```text
OpenStreetMap planet data
    ├─ OpenFreeMap/OpenMapTiles tiles ──> visual basemap + contextual buildings
    └─ custom game-road tiles ─────────> lanes/speed/width/surface/topology

DEM elevation tiles ───────────────────> terrain surface

                         browser workers
                              │
                 stitch / drape / generate LOD
                     ┌────────┴────────┐
                     │                 │
              visual scene       collision scene
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the staged plan.

## Roadmap

1. **Map foundation** — OpenFreeMap + MapLibre + basic 3D building extrusion. *(complete)*
2. **Procedural building LOD2** — façade segmentation, generated window/material patterns, façade families and roof caps. *(current)*
3. **Procedural building LOD3** — true façade bays, doors, roof generators, balconies/details, apparent interiors and optional custom landmark models.
4. **Game-road schema** — generate a separate Planetiler profile that retains stable OSM IDs and driving attributes such as `lanes`, `maxspeed`, `width`, `surface`, `smoothness`, `oneway`, `bridge`, `tunnel`, and `layer`.
5. **DEM terrain** — add a pluggable elevation-tile provider and terrain mesh generation.
6. **World streaming** — worker-based decoding, tile-edge stitching, LOD, local/floating origin, memory budgets, and near-player collision generation.
7. **Driving layer** — robust road surfaces, intersections, bridge/tunnel separation and vehicle physics.

## Data and attribution

The Apache-2.0 licence in this repository applies to Mapshow's own source code. It does not relicense third-party map data, styles, fonts, libraries or services. See [`THIRD_PARTY.md`](THIRD_PARTY.md).
