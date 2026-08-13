# Mapshow

Mapshow is an open-data browser prototype for turning global map data into a lightweight, driveable 3D world.

It deliberately separates **visual mapping**, **simulation road data**, **procedural world geometry**, and **physics** so each layer can evolve independently.

## Current stack

- **OpenFreeMap / OpenStreetMap** — global visual basemap and building footprints.
- **MapLibre GL JS** — map rendering and real DEM terrain.
- **Three.js** — close-range procedural buildings, road surfaces and physics debug rendering.
- **Rust `road-schema/`** — topology-aware OSM PBF → schema-v3 game-road MVT/PMTiles generator.
- **Rapier 3D** — streamed static road/intersection collision plus dynamic validation bodies.

Mapshow does not use Google Maps, commercial satellite imagery or photogrammetry. MGame and Hop.Earth are architectural references only; their code and assets are not copied into this repository.

## What works now

The browser prototype currently has:

- global OpenFreeMap basemap;
- real 3D terrain from Terrarium DEM tiles;
- procedural building LOD1/LOD2/LOD3 with bounded nearby streaming;
- a dedicated `game_road` vector-tile schema generated from OSM PBF in Rust;
- road splitting at real shared OSM nodes;
- directed road topology and lane centre-lines;
- explicit left- and right-hand traffic placement;
- `turn:lanes*` filtering and simple unconditional via-node OSM turn restrictions;
- terrain-aware road profiles and generated intersection surfaces;
- simplified road/intersection collision meshes;
- a floating local physics frame in metres;
- streamed Rapier static trimesh colliders;
- optional Rapier collision debug rendering;
- a dynamic drop probe for contact/rebase validation;
- a **minimal single-body chassis** with temporary W/S thrust, A/D yaw torque and Space braking.

The chassis is **not the final vehicle model**. There are no wheels, suspension, tyre slip forces or production driving dynamics yet. Direct force/torque controls exist only to validate persistent dynamic-body motion on the streamed road world before suspension and tyre physics are added.

## Quick start

Requirements:

- Node.js 22+
- npm
- Rust stable only if you want to generate game-road tiles

Run the browser app:

```bash
npm install
npm run dev
```

Run browser/world tests:

```bash
npm test
```

Production build:

```bash
npm run build
npm run preview
```

Without `VITE_GAME_ROADS_TILEJSON`, the map, terrain and buildings still work. Simulation road surfaces and road physics remain disabled rather than silently using the cartographic road layer.

## Browser controls

The prototype UI provides:

- location presets;
- terrain and procedural-building toggles;
- generated road-surface toggle;
- manual left/right traffic selection;
- Rapier debug overlay;
- **Drop physics probe**;
- **Spawn chassis**.

When the minimal chassis is active:

```text
W / S     temporary forward / reverse thrust
A / D     temporary yaw torque
Space     temporary direct braking force
```

These controls test rigid-body continuity only. They will be replaced by suspension/tyre-generated forces in the real vehicle model.

## Architecture

```text
OpenFreeMap / OpenMapTiles             Terrarium DEM
          │                                 │
          ▼                                 ▼
      MapLibre GL JS ─────────────────── 3D terrain
          │                                 │
          ├─ visual map                     └─ elevation sampling
          ├─ LOD1/LOD2 buildings                    │
          │                                          ▼
          └──────────────┐                    road/building Z
                         │
                         ▼
                    Three.js
              LOD3 buildings + roads

OSM .osm.pbf
     │
     ▼
Rust `road-schema/`
     │
     ├─ shared-node topology
     ├─ schema-v3 road metadata
     ├─ turn/restriction metadata
     └─ buffered MVT clipping
     │
     ├───────────────┐
     ▼               ▼
XYZ .pbf          PMTiles v3
+ TileJSON
     │
     ▼
Browser road-world assembler
     │
     ├─ directed graph
     ├─ lane/turn policy
     ├─ terrain-aware road surfaces
     └─ simplified collision triangles
             │
             ▼
     floating-origin adapter
       X east / Y up / Z north
             │
             ▼
          Rapier 3D
     static road colliders
       + probe + chassis
```

The important separation is that **OpenFreeMap is the visual map layer**, while Rust-generated `game_road` tiles are a simulation dataset. Cartographic transportation tiles are never treated as physics-ready road geometry.

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and data flow;
- [`docs/GAME_ROADS.md`](docs/GAME_ROADS.md) — schema-v3 generator and browser road world;
- [`docs/PHYSICS.md`](docs/PHYSICS.md) — floating-origin and dynamic-body lifecycle;
- [`docs/RAPIER.md`](docs/RAPIER.md) — Rapier-specific integration details.

## Generate game-road tiles

`road-schema/` is a Rust binary/library using a multi-pass, disk-backed pipeline so large extracts do not require the whole road graph or all generated tiles in RAM.

Run Rust tests:

```bash
cargo fmt --manifest-path road-schema/Cargo.toml --all -- --check
cargo test --manifest-path road-schema/Cargo.toml --all-targets
```

Build XYZ MVT plus `tilejson.json`:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-xyz \
  --input data/region.osm.pbf \
  --output-dir data/game-roads \
  --tile-url-template 'https://tiles.example.com/game-roads/{z}/{x}/{y}.pbf'
```

Or build a PMTiles archive:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-pmtiles \
  --input data/region.osm.pbf \
  --output data/game-roads.pmtiles
```

Configure the current browser runtime with the XYZ/TileJSON output:

```bash
VITE_GAME_ROADS_TILEJSON=https://tiles.example.com/game-roads/tilejson.json
VITE_GAME_ROADS_DEBUG=false
npm run dev
```

Direct PMTiles loading in the browser is not wired yet; PMTiles is currently an alternative static output artifact.

## Testing

CI has two independent paths.

### Browser/world tests

`npm test` uses Vitest to cover both pure contracts and the actual Rapier/WASM boundary:

- floating-origin frame changes and world-position preservation;
- road collision strip generation and triangle accounting;
- physics-adapter create/update/remove behavior;
- minimal chassis control clamping, orientation and force calculation;
- a real Rapier world with a static road trimesh, a falling chassis, contact verification and controlled forward motion.

`npm run build` separately runs strict TypeScript checking and the Vite production build.

### Rust generator tests

CI runs Rust formatting and unit tests, then downloads a real Monaco `.osm.pbf` extract and requires both non-empty XYZ MVT/TileJSON and PMTiles output.

## Known limitations

Mapshow currently preserves or postpones rather than guesses several systems:

- conditional and via-way turn restrictions;
- traffic-signal phases;
- `change:lanes*` enforcement;
- jurisdiction-specific driving policy;
- route search and lane following;
- direct PMTiles loading in the browser;
- survey-grade bridge/tunnel elevations;
- wheel/suspension dynamics;
- tyre friction/slip forces;
- production throttle/brake/steering behavior;
- dynamic traffic and collision filtering.

The current DEM and OSM geometry are procedural world-generation inputs, not engineering survey geometry.

## Project layout

```text
src/map/                    browser map/world/physics modules
src/map/*.test.ts           browser unit + Rapier integration tests
road-schema/                Rust OSM → game-road tile generator
docs/ARCHITECTURE.md        system architecture
docs/GAME_ROADS.md          road schema/generator/runtime details
docs/PHYSICS.md             floating-origin and physics lifecycle
docs/RAPIER.md              Rapier integration notes
THIRD_PARTY.md              data/software licensing and attribution
```

## Data and licensing

Mapshow's own source code is Apache-2.0. OpenStreetMap data, OpenFreeMap/OpenMapTiles resources, elevation datasets and third-party libraries keep their own licences and attribution requirements.

See [`THIRD_PARTY.md`](THIRD_PARTY.md).
