# Mapshow

Mapshow is an open-data browser prototype for building a lightweight, driveable 3D world from global map data.

It combines:

- **OpenFreeMap / OpenStreetMap** for the visual basemap and building footprints;
- **MapLibre GL JS** for map rendering and DEM terrain;
- **Three.js** for close-range procedural buildings and road geometry;
- a **Rust game-road generator** for topology-aware simulation tiles;
- **Rapier 3D** for streamed road/intersection collision bodies and physics validation.

Mapshow does not use Google Maps, commercial satellite imagery, or photogrammetry. It also does not contain source code or assets copied from MGame or Hop.Earth; those projects are architectural references only.

## What works now

The current prototype has:

- global OpenFreeMap basemap;
- real 3D terrain from Terrarium DEM tiles;
- procedural building LOD1/LOD2/LOD3;
- bounded nearby building streaming;
- a dedicated `game_road` vector-tile schema generated from OSM PBF in Rust;
- road splitting at real shared OSM nodes;
- directed road topology and lane centre-lines;
- left- and right-hand traffic placement;
- `turn:lanes*` filtering;
- simple unconditional via-node `no_*` / `only_*` OSM restriction enforcement;
- terrain-aware road profiles, bridges/tunnels and generated intersection surfaces;
- simplified road/intersection collision meshes;
- a floating physics origin using local metres;
- streamed Rapier static trimesh colliders;
- an optional Rapier collision debug overlay;
- a minimal dynamic drop-probe for testing gravity, contact, collider streaming and floating-origin rebasing.

There is **not yet a vehicle controller**. Suspension, tyre forces, throttle/braking, steering and player driving are later milestones.

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

Production build:

```bash
npm run build
npm run preview
```

Without a configured game-road TileJSON endpoint, the map, terrain and buildings still work; simulation road surfaces and physics colliders remain disabled.

When game-road tiles are configured and nearby road colliders are loaded, use **Drop physics probe** to spawn a small dynamic Rapier cuboid several metres above the nearest active road collider. The probe automatically enables the physics debug overlay so its fall and contact can be inspected.

## Architecture

```text
OpenFreeMap / OpenMapTiles          Terrarium DEM
          │                              │
          ▼                              ▼
      MapLibre GL JS ─────────────── 3D terrain
          │                              │
          ├─ visual map                  └─ elevation sampling
          ├─ LOD1/LOD2 buildings              │
          │                                    ▼
          └──────────────┐              road/building Z
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
     └─ MVT clipping
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
     ├─ lane policy
     ├─ legal turn graph
     ├─ terrain-aware road surfaces
     └─ collision triangle bodies
             │
             ▼
     floating-origin adapter
       X east / Y up / Z north
             │
             ▼
          Rapier 3D
     static road colliders
       + dynamic probe
```

The important separation is that **OpenFreeMap is the visual map layer**, while the Rust `game_road` tiles are a separate simulation-oriented dataset. Cartographic road tiles are not treated as physics-ready road geometry.

## Generate game-road tiles

`road-schema/` is a Rust binary/library using a multi-pass, disk-backed pipeline so large extracts do not require the whole road graph or all generated tiles in RAM.

Run tests:

```bash
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

Configure the browser to use XYZ/TileJSON output:

```bash
VITE_GAME_ROADS_TILEJSON=https://tiles.example.com/game-roads/tilejson.json
VITE_GAME_ROADS_DEBUG=false
npm run dev
```

Direct PMTiles loading in the browser is not wired yet; PMTiles is currently an alternative static output artifact.

## Physics model

Map rendering stays in Web Mercator. Physics does not.

Mapshow uses a floating local physics frame:

- `+X` east
- `+Y` up
- `+Z` north
- units in metres

The camera currently acts as a temporary player proxy. The origin rebases after roughly 400 m. Road and intersection collision bodies keep stable IDs and are added, replaced or removed from Rapier as the streamed road world changes.

The dynamic probe is deliberately simple: a small cuboid with gravity, mass, friction, low restitution and CCD. It is a validation instrument for road contacts and origin rebasing, not an early car model. When the floating origin moves, the probe is transformed into the new local frame while its physical velocity and orientation are preserved.

See [`docs/PHYSICS.md`](docs/PHYSICS.md) and [`docs/RAPIER.md`](docs/RAPIER.md) for the coordinate, collider and engine boundaries.

## Building LODs

```text
LOD1  footprint → simple map extrusion
LOD2  footprint + height → segmented/patterned façade
LOD3  nearby footprint → generated windows, entrance and roof geometry
```

LOD3 is deliberately bounded to keep browser memory and GPU usage predictable.

## Road policy and known limitations

Mapshow currently distinguishes raw topology, legal lane connectivity, rendered road geometry and collision geometry.

Implemented policy includes `turn:lanes*` and simple unconditional via-node restriction relations. The following are preserved or planned rather than guessed:

- conditional restrictions;
- via-way restrictions;
- traffic-signal phases;
- `change:lanes*` enforcement;
- jurisdiction-specific driving rules;
- full route search;
- exact surveyed bridge/tunnel elevations.

The DEM and OSM data are suitable for procedural world generation, not survey-grade engineering geometry.

## Project layout

```text
src/map/                 browser map/world modules
road-schema/             Rust OSM → game-road tile generator
docs/GAME_ROADS.md       game-road schema and generation details
docs/PHYSICS.md          floating-origin and physics lifecycle
docs/RAPIER.md           Rapier-specific integration notes
docs/ARCHITECTURE.md     broader system architecture
THIRD_PARTY.md           data/software licensing and attribution
```

## Data and licensing

Mapshow's own source code is Apache-2.0. OpenStreetMap data, OpenFreeMap/OpenMapTiles resources, elevation datasets and third-party libraries keep their own licences and attribution requirements.

See [`THIRD_PARTY.md`](THIRD_PARTY.md).
