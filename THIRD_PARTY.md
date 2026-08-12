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

## Planetiler

`road-schema/` uses Planetiler to preprocess OpenStreetMap PBF data into the separate `game_road` vector-tile layer. Mapshow currently pins Planetiler **v0.10.2**. Planetiler is distributed under the Apache License 2.0.

Planetiler's software licence is separate from the ODbL obligations on the OpenStreetMap data being processed. Generated game-road tiles remain derived from OSM data and must retain the appropriate OSM attribution/licence treatment.

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

Three.js is used by Mapshow's close-range LOD3 custom map layer for generated window, entrance and roof geometry. Three.js is distributed under the MIT licence. Mapshow does not bundle third-party building models or textures with this layer; its current LOD3 geometry is generated from map data at runtime.

## MGame and Hop.Earth

MGame and Hop.Earth are research/architectural references for this project. No source code, textures, models, or other assets from those projects are included in the Mapshow implementation.

Any future reuse of third-party code or assets must be reviewed separately for licence compatibility before it is committed.
