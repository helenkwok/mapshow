# Mapshow

Mapshow is an open-data browser prototype for turning global map data into a lightweight, driveable 3D world.

The project deliberately separates four concerns:

1. **Visual map** — OpenFreeMap/OpenStreetMap rendered by MapLibre GL JS.
2. **World geometry** — procedural buildings, terrain-aware roads and intersections rendered with MapLibre/Three.js.
3. **Simulation data** — a Rust-generated `game_road` tileset that preserves topology and driving metadata instead of treating cartographic roads as physics-ready geometry.
4. **Physics** — a floating-origin local-metre world backed by Rapier 3D.

MGame and Hop.Earth are architectural references only. Their code and assets are not copied into this repository.

## What works now

Mapshow currently includes:

- global OpenFreeMap basemap;
- real 3D terrain from Terrarium DEM tiles;
- procedural building LOD1/LOD2/LOD3 with bounded nearby streaming;
- Rust OSM PBF → schema-v3 game-road MVT/PMTiles generation;
- road splitting at real shared OSM nodes;
- directed road topology and lane centre-lines;
- left- and right-hand traffic placement;
- `turn:lanes*` filtering and simple unconditional via-node OSM turn restrictions;
- terrain-aware road profiles and generated intersection surfaces;
- simplified road/intersection collision meshes;
- a floating local physics frame in metres;
- streamed Rapier static road/intersection trimesh colliders;
- optional Rapier collision debug rendering;
- a dynamic drop probe for contact/rebase validation;
- a **four-wheel Rapier raycast suspension chassis** with front steering, rear-wheel drive and all-wheel braking.

The vehicle is still a development model. The wheels are raycast contacts, not physical wheel rigid bodies, and Rapier's built-in wheel friction/slip behavior is being used as a first contact model rather than a final tyre simulation.

## Quick start

Requirements:

- Node.js 22+
- npm
- Rust stable only if you want to generate `game_road` tiles

For the visual map, terrain and buildings:

```bash
npm install
npm run dev
```

Without a `game_road` TileJSON source, simulation road surfaces and road physics stay disabled. OpenFreeMap streets, labels, terrain and buildings still work.

### Enable local simulation roads and physics

For one of Mapshow's built-in locations, `roads:build` can download and cache a matching OpenStreetMap PBF automatically:

```bash
npm run roads:build -- adelaide
npm run dev:roads
```

Available presets:

```text
adelaide    Adelaide
hong-kong   Hong Kong
manhattan   Manhattan / New York
 tokyo      Tokyo
```

You can list them at any time with:

```bash
npm run roads:build -- --list
```

The presets use city/region OSM extracts from BBBike or Geofabrik and cache the downloaded `.osm.pbf` under `.cache/mapshow/osm/`. Re-running the same preset reuses the cached file.

You can also pass your own local PBF or a direct HTTP(S) URL:

```bash
npm run roads:build -- path/to/region.osm.pbf
npm run roads:build -- https://example.com/region.osm.pbf
```

`data/region.osm.pbf` is **not** bundled with Mapshow; it was an old example placeholder and should not be copied literally.

`roads:build` runs the Rust generator and writes temporary development output to:

```text
public/game-roads/tilejson.json
public/game-roads/{z}/{x}/{y}.pbf
```

The build is staged in `public/.game-roads-build/` and only replaces the previous `public/game-roads/` after Rust succeeds, so a failed build does not destroy the last working local tiles.

`dev:roads` starts Vite in a dedicated `roads` mode on `http://localhost:5173` and points Mapshow at that same-origin TileJSON automatically. It uses `--strictPort` because the generated TileJSON also targets port 5173; if that port is occupied, Vite fails instead of silently changing ports.

**The extract must cover the location currently shown in Mapshow.** For example, an Adelaide extract will not provide simulation road surfaces while the map is positioned in Manhattan.

For an externally hosted road tileset, continue to use `VITE_GAME_ROADS_TILEJSON`; `npm run dev:roads` is only a local convenience mode.

Tests and production build:

```bash
npm test
npm run build
npm run preview
```

## Browser controls

The UI provides:

- location presets;
- terrain and procedural-building toggles;
- generated road-surface toggle;
- left/right traffic selection;
- Rapier debug overlay;
- **Drop physics probe**;
- **Spawn chassis**.

When the chassis is active:

```text
W / S     forward / reverse wheel engine force
A / D     front-wheel steering
Space     all-wheel brake
```

These controls are for validating suspension/contact and streamed-world continuity. They are not yet a production powertrain, steering or tyre model.

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
             │
       ┌─────┴─────┐
       ▼           ▼
   drop probe   raycast vehicle
                 ├─ 4 wheel rays
                 ├─ spring/damping
                 ├─ front steering
                 └─ rear drive
```

The important boundary is that **OpenFreeMap is the visual map**, while Rust-generated `game_road` tiles are the simulation road dataset. Cartographic transportation tiles are never treated as collision-grade road geometry.

Detailed docs:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and data flow;
- [`docs/GAME_ROADS.md`](docs/GAME_ROADS.md) — schema-v3 generator and browser road world;
- [`docs/PHYSICS.md`](docs/PHYSICS.md) — floating-origin and dynamic-body lifecycle;
- [`docs/RAPIER.md`](docs/RAPIER.md) — Rapier-specific integration and vehicle contact model.

## Generate game-road tiles

`road-schema/` is a Rust binary/library using a multi-pass, disk-backed pipeline so large extracts do not require the whole road graph or all generated tiles in RAM.

Run Rust checks:

```bash
cargo fmt --manifest-path road-schema/Cargo.toml --all -- --check
cargo test --manifest-path road-schema/Cargo.toml --all-targets
```

For local Vite development, prefer the `roads:build` workflow above. For hosted XYZ MVT plus `tilejson.json`:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-xyz \
  --input path/to/region.osm.pbf \
  --output-dir data/game-roads \
  --tile-url-template 'https://tiles.example.com/game-roads/{z}/{x}/{y}.pbf'
```

Or build a PMTiles archive:

```bash
cargo run --release --manifest-path road-schema/Cargo.toml -- \
  build-pmtiles \
  --input path/to/region.osm.pbf \
  --output data/game-roads.pmtiles
```

Configure an externally hosted XYZ/TileJSON source with:

```bash
VITE_GAME_ROADS_TILEJSON=https://tiles.example.com/game-roads/tilejson.json
VITE_GAME_ROADS_DEBUG=false
npm run dev
```

Direct PMTiles loading in the browser is not wired yet; PMTiles is currently an alternative static output artifact.

## Physics and vehicle model

Physics runs in a local floating frame rather than Web Mercator:

```text
+X east
+Y up
+Z north
units: metres
```

The camera is currently the floating-origin proxy. After roughly 400 m, static colliders are re-expressed in the new local frame and active dynamic bodies are transformed so their physical world location is preserved.

The current chassis uses Rapier's `DynamicRayCastVehicleController`:

- four wheel rays derived from chassis dimensions;
- suspension rest length and bounded travel;
- spring stiffness plus compression/relaxation damping;
- maximum suspension force;
- front-wheel steering with reduced authority at speed;
- rear-wheel engine force;
- all-wheel braking;
- wheel friction/slip and side-friction tuning;
- per-wheel contact, suspension length/force and impulse diagnostics.

This is a much better contact model than applying force and yaw torque directly to the chassis, but it remains a validation stage. A later tyre model can use wheel load/contact data to implement more explicit longitudinal/lateral slip behavior.

## Testing

CI has two independent paths.

### Browser/world tests

`npm test` uses Vitest to cover:

- floating-origin frame changes and world-position preservation;
- road collision simplification and mesh generation;
- physics-adapter create/update/remove lifecycle;
- chassis configuration and control normalization;
- wheel layout and control-to-wheel mapping;
- a real Rapier/WASM world where the four-wheel suspension settles onto a static road trimesh;
- wheel-driven forward motion on that trimesh.

`npm run build` separately runs strict TypeScript checking and the Vite production build. CI also runs `npm run roads:build -- --list` as a no-network syntax smoke check for the local road preset helper.

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
- physical wheel rigid bodies and wheel-to-visual animation;
- custom tyre load/slip curves and drivetrain modeling;
- production throttle/brake/steering behavior;
- dynamic traffic and collision filtering.

The current DEM and OSM geometry are procedural world-generation inputs, not engineering survey geometry.

## Project layout

```text
src/map/                       browser map/world/physics modules
src/map/vehicle-chassis.ts    chassis dimensions + control contract
src/map/vehicle-suspension.ts raycast wheel/suspension configuration
src/map/*.test.ts             browser unit + Rapier integration tests
road-schema/                  Rust OSM → game-road tile generator
scripts/                      local development helpers
.cache/mapshow/osm/           downloaded local OSM PBF cache (ignored)
public/game-roads/            generated local XYZ tiles (ignored)
docs/ARCHITECTURE.md          system architecture
docs/GAME_ROADS.md            road schema/generator/runtime details
docs/PHYSICS.md               floating-origin and physics lifecycle
docs/RAPIER.md                Rapier integration notes
THIRD_PARTY.md                 data/software licensing and attribution
```

## Data and licensing

Mapshow's own source code is Apache-2.0. OpenStreetMap data, OpenFreeMap/OpenMapTiles resources, elevation datasets and third-party libraries keep their own licences and attribution requirements.

Preset downloads are convenience inputs only; the underlying OpenStreetMap data remains ODbL-licensed. See [`THIRD_PARTY.md`](THIRD_PARTY.md).
