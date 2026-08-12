# Third-party data and software

Mapshow's source code is licensed under Apache-2.0. Third-party software, map data, styles and hosted services keep their own licences and terms.

## OpenStreetMap

Map data used through OpenFreeMap is derived from OpenStreetMap. OpenStreetMap data is licensed under the Open Data Commons Open Database License (ODbL). Applications must provide the required OpenStreetMap attribution and must not assume that Mapshow's Apache-2.0 licence applies to the map database.

## OpenFreeMap / OpenMapTiles

The prototype uses the hosted OpenFreeMap Liberty style at:

```text
https://tiles.openfreemap.org/styles/liberty
```

OpenFreeMap combines OpenStreetMap-derived tiles with OpenMapTiles schema/styles and other third-party resources. Their respective attribution and licence requirements continue to apply. The hosted service is an external dependency; production deployments should review its current terms and may choose self-hosted tiles.

## MapLibre GL JS

MapLibre GL JS is used as the browser vector-map renderer and is distributed under the BSD 3-Clause licence.

## Three.js

Three.js is used by Mapshow's close-range LOD3 custom map layer for generated window, entrance and roof geometry. Three.js is distributed under the MIT licence. Mapshow does not bundle third-party building models or textures with this layer; its current LOD3 geometry is generated from map data at runtime.

## MGame and Hop.Earth

MGame and Hop.Earth are research/architectural references for this project. No source code, textures, models, or other assets from those projects are included in the Mapshow implementation.

Any future reuse of third-party code or assets must be reviewed separately for licence compatibility before it is committed.
