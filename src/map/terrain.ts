import type {
  HillshadeLayerSpecification,
  Map as MapLibreMap,
  RasterDEMSourceSpecification,
} from "maplibre-gl";

export const TERRAIN_SOURCE_ID = "mapshow-terrain-dem";
export const TERRAIN_HILLSHADE_LAYER_ID = "mapshow-terrain-hillshade";

export interface TerrainProvider {
  id: string;
  label: string;
  source: RasterDEMSourceSpecification;
  notes: string;
}

const TILEZEN_ATTRIBUTION = [
  "Terrain: ArcticDEM/NSF",
  "© Commonwealth of Australia (Geoscience Australia) 2017",
  "© offene Daten Österreichs – DGM Österreich",
  "Canada Open Government Licence",
  "EU-DEM/Copernicus",
  "NOAA ETOPO1",
  "INEGI Continental relief 2016",
  "© LINZ/New Zealand Government",
  "© Kartverket",
  "© Environment Agency 2015",
  "USGS 3DEP/GMTED2010/SRTM",
].join(" · ");

export const AWS_TERRARIUM_PROVIDER: TerrainProvider = {
  id: "aws-tilezen-terrarium",
  label: "AWS Terrain Tiles / Tilezen",
  notes:
    "Worldwide Terrarium-encoded elevation tiles from the AWS Open Data elevation-tiles-prod bucket; max native tile zoom 15.",
  source: {
    type: "raster-dem",
    tiles: [
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    ],
    encoding: "terrarium",
    tileSize: 256,
    minzoom: 0,
    maxzoom: 15,
    attribution: TILEZEN_ATTRIBUTION,
  },
};

export interface TerrainInstallation {
  provider: TerrainProvider;
  sourceId: string;
  hillshadeLayerId: string;
}

export function installTerrain(
  map: MapLibreMap,
  provider: TerrainProvider = AWS_TERRARIUM_PROVIDER,
): TerrainInstallation {
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, provider.source);
  }

  if (!map.getLayer(TERRAIN_HILLSHADE_LAYER_ID)) {
    const firstSymbolLayer = map
      .getStyle()
      .layers?.find((layer) => layer.type === "symbol")?.id;

    const hillshade: HillshadeLayerSpecification = {
      id: TERRAIN_HILLSHADE_LAYER_ID,
      type: "hillshade",
      source: TERRAIN_SOURCE_ID,
      minzoom: 4,
      maxzoom: 16,
      paint: {
        "hillshade-exaggeration": 0.28,
        "hillshade-shadow-color": "#473f35",
        "hillshade-highlight-color": "#f6f0df",
        "hillshade-accent-color": "#6d655c",
      },
    };

    map.addLayer(hillshade, firstSymbolLayer);
  }

  return {
    provider,
    sourceId: TERRAIN_SOURCE_ID,
    hillshadeLayerId: TERRAIN_HILLSHADE_LAYER_ID,
  };
}

export function setTerrainEnabled(
  map: MapLibreMap,
  enabled: boolean,
  exaggeration = 1,
): void {
  map.setTerrain(enabled ? { source: TERRAIN_SOURCE_ID, exaggeration } : null);
  if (map.getLayer(TERRAIN_HILLSHADE_LAYER_ID)) {
    map.setLayoutProperty(
      TERRAIN_HILLSHADE_LAYER_ID,
      "visibility",
      enabled ? "visible" : "none",
    );
  }
}

export function terrainElevationAt(
  map: MapLibreMap,
  center: [number, number],
): number {
  return map.queryTerrainElevation(center) ?? 0;
}
