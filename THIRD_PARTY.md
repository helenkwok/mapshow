# Third-party data and software

Mapshow's source code is licensed under Apache-2.0. Third-party software, map data, elevation data, styles and hosted services keep their own licences and terms.

## OpenStreetMap

Map data used through OpenFreeMap and the `road-schema/` game-road generator is derived from OpenStreetMap. OpenStreetMap data is licensed under the Open Data Commons Open Database License (ODbL). Applications and generated tiles must provide required OpenStreetMap attribution and must not assume that Mapshow's Apache-2.0 licence applies to the map database or derived database rights.

## OpenFreeMap / OpenMapTiles

The prototype uses the hosted OpenFreeMap Liberty style at:

```text
https://tiles.openfreemap.org/styles/liberty
```

OpenFreeMap combines OpenStreetMap-derived tiles with OpenMapTiles schema/styles and other third-party resources. Their respective attribution and licence requirements continue to apply. The hosted service is an external dependency; production deployments should review its current terms and may choose self-hosted tiles.

## Rust game-road generator dependencies

`road-schema/` is implemented in Rust. The generator's software licence is separate from the ODbL obligations on the OpenStreetMap data it processes. Generated game-road tiles remain derived from OSM data and must retain appropriate OSM attribution/licence treatment.

Core direct libraries used by the generator include:

- `osmpbf` for reading OpenStreetMap PBF files — MIT OR Apache-2.0;
- `redb` for temporary disk-backed build state — MIT OR Apache-2.0;
- `pmtiles-rs` (`pmtiles` crate) for optional PMTiles v3 output — MIT OR Apache-2.0;
- `prost` for the local Mapbox Vector Tile protobuf encoder — Apache-2.0.

The complete Rust dependency graph is defined by `road-schema/Cargo.toml` and Cargo's resolved dependency metadata. Deployments or redistributed binaries should retain notices required by all direct and transitive dependencies.

## AWS Terrain Tiles / Tilezen / Joerd

The default real-terrain provider reads Terrarium PNG tiles from the public AWS Open Data bucket `elevation-tiles-prod`:

```text
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

The AWS Open Data Registry describes Terrain Tiles as a global bare-earth terrain-height dataset managed by Mapzen, a Linux Foundation project. The data is assembled from multiple upstream elevation datasets rather than being a single Copernicus product.

Tilezen/Joerd documents required attribution for its contributing terrain datasets. Mapshow passes a compact attribution string to MapLibre's attribution control covering ArcticDEM/NSF, Geoscience Australia, Austrian open elevation, Canadian Open Government data, EU-DEM/Copernicus, NOAA ETOPO1, INEGI, LINZ, Kartverket, the UK Environment Agency and USGS 3DEP/GMTED2010/SRTM. The authoritative attribution details remain those published by Tilezen/Joerd; deployments that redistribute terrain data should review each upstream licence directly.

The Terrarium encoding stores elevation in RGB using:

```text
(red * 256 + green + blue / 256) - 32768
```

MapLibre performs this decoding through its `raster-dem` source with `encoding: "terrarium"`.

## Copernicus DEM

Copernicus GLO-30 is a planned alternative/self-hosted terrain input, not the source used by the current default provider. If Mapshow later publishes Copernicus-derived tiles, the applicable Copernicus Data Space licence and attribution requirements must be added for that derived terrain product.

## MapLibre GL JS

MapLibre GL JS is used as the browser vector-map renderer and terrain renderer and is distributed under the BSD 3-Clause licence.

## Three.js

Three.js is used for Mapshow's close-range procedural geometry and custom 3D map layers. Three.js is distributed under the MIT licence. Mapshow does not bundle third-party building models or textures with its current procedural LOD3 layer.

## Rapier 3D

Mapshow uses `@dimforge/rapier3d-compat` for browser physics. Rapier is distributed under the Apache-2.0 licence. The `-compat` package provides the WebAssembly integration path used by the browser build.

Rapier currently receives Mapshow-generated static road/intersection trimesh colliders and also runs Mapshow's local dynamic validation bodies (the drop probe and minimal single-body chassis). OSM-derived road/collision geometry remains subject to the underlying OSM data obligations; using Rapier does not change those data-licence requirements.

## Browser test tooling

Mapshow uses Vitest as a development/test dependency for the browser-world unit suite. Vitest is distributed under the MIT licence. Test tooling is not part of the generated OSM data product and does not change map/elevation data licensing obligations.

The web dependency graph is defined by `package.json` and npm's resolved dependency metadata. Redistributed application bundles or development environments should retain notices required by their direct and transitive dependencies.

## MGame and Hop.Earth

MGame and Hop.Earth are research/architectural references for this project. No source code, textures, models, or other assets from those projects are included in the Mapshow implementation.

Any future reuse of third-party code or assets must be reviewed separately for licence compatibility before it is committed.
