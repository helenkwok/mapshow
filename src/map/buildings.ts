import type { LayerSpecification, Map as MapLibreMap } from "maplibre-gl";
import {
  DEFAULT_BUILDING_HEIGHT,
  GROUND_FLOOR_HEIGHT,
  LOW_RISE_MAX_HEIGHT,
  MID_RISE_MAX_HEIGHT,
  ROOF_CAP_HEIGHT,
} from "./building-profile";
import { BUILDING_PATTERNS, registerBuildingPatterns } from "./building-patterns";

const LOD_LAYER_ID = "mapshow-buildings-lod1";
const GROUND_LAYER_ID = "mapshow-buildings-ground";
const LOW_RISE_LAYER_ID = "mapshow-buildings-low-rise";
const MID_RISE_LAYER_ID = "mapshow-buildings-mid-rise";
const HIGH_RISE_LAYER_ID = "mapshow-buildings-high-rise";
const ROOF_LAYER_ID = "mapshow-buildings-roof-cap";

const MANAGED_LAYER_IDS = [
  LOD_LAYER_ID,
  GROUND_LAYER_ID,
  LOW_RISE_LAYER_ID,
  MID_RISE_LAYER_ID,
  HIGH_RISE_LAYER_ID,
  ROOF_LAYER_ID,
];

type VectorLayer = LayerSpecification & {
  source?: string;
  "source-layer"?: string;
};

export interface BuildingInstallation {
  layerIds: string[];
  mode: "procedural" | "style" | "none";
}

function isBuildingLayer(layer: LayerSpecification): layer is VectorLayer {
  const candidate = layer as VectorLayer;
  return candidate["source-layer"] === "building" && typeof candidate.source === "string";
}

function isBuildingExtrusion(layer: LayerSpecification): layer is VectorLayer {
  return layer.type === "fill-extrusion" && isBuildingLayer(layer);
}

function addLayerIfMissing(
  map: MapLibreMap,
  layer: LayerSpecification,
  beforeId?: string,
): void {
  if (!map.getLayer(layer.id)) {
    map.addLayer(layer, beforeId);
  }
}

export function installProceduralBuildings(map: MapLibreMap): BuildingInstallation {
  const layers = map.getStyle().layers ?? [];
  const existingExtrusions = layers.filter(isBuildingExtrusion);
  const sourceLayer = layers.find(isBuildingLayer);

  if (!sourceLayer?.source) {
    const existingIds = existingExtrusions.map((layer) => layer.id);
    return {
      layerIds: existingIds,
      mode: existingIds.length > 0 ? "style" : "none",
    };
  }

  registerBuildingPatterns(map);

  for (const layer of existingExtrusions) {
    map.setLayoutProperty(layer.id, "visibility", "none");
  }

  const source = sourceLayer.source;
  const firstSymbolLayer = layers.find((layer) => layer.type === "symbol")?.id;
  const height = ["coalesce", ["get", "render_height"], DEFAULT_BUILDING_HEIGHT];
  const minHeight = ["coalesce", ["get", "render_min_height"], 0];
  const groundTop = ["min", ["+", minHeight, GROUND_FLOOR_HEIGHT], height];

  addLayerIfMissing(
    map,
    {
      id: LOD_LAYER_ID,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 13.5,
      maxzoom: 15.3,
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          height,
          0,
          "#d7d1c8",
          30,
          "#c1bcb4",
          100,
          "#a6a7a7",
          250,
          "#8a9095",
        ],
        "fill-extrusion-height": height,
        "fill-extrusion-base": minHeight,
        "fill-extrusion-opacity": 0.92,
      },
    } as LayerSpecification,
    firstSymbolLayer,
  );

  addLayerIfMissing(
    map,
    {
      id: GROUND_LAYER_ID,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 15.3,
      paint: {
        "fill-extrusion-pattern": BUILDING_PATTERNS.ground,
        "fill-extrusion-height": groundTop,
        "fill-extrusion-base": minHeight,
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false,
      },
    } as LayerSpecification,
    firstSymbolLayer,
  );

  addLayerIfMissing(
    map,
    {
      id: LOW_RISE_LAYER_ID,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 15.3,
      filter: ["<", height, LOW_RISE_MAX_HEIGHT],
      paint: {
        "fill-extrusion-pattern": BUILDING_PATTERNS.brick,
        "fill-extrusion-height": height,
        "fill-extrusion-base": groundTop,
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false,
      },
    } as LayerSpecification,
    firstSymbolLayer,
  );

  addLayerIfMissing(
    map,
    {
      id: MID_RISE_LAYER_ID,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 15.3,
      filter: [
        "all",
        [">=", height, LOW_RISE_MAX_HEIGHT],
        ["<", height, MID_RISE_MAX_HEIGHT],
      ],
      paint: {
        "fill-extrusion-pattern": BUILDING_PATTERNS.masonry,
        "fill-extrusion-height": height,
        "fill-extrusion-base": groundTop,
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false,
      },
    } as LayerSpecification,
    firstSymbolLayer,
  );

  addLayerIfMissing(
    map,
    {
      id: HIGH_RISE_LAYER_ID,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 15.3,
      filter: [">=", height, MID_RISE_MAX_HEIGHT],
      paint: {
        "fill-extrusion-pattern": BUILDING_PATTERNS.glass,
        "fill-extrusion-height": height,
        "fill-extrusion-base": groundTop,
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false,
      },
    } as LayerSpecification,
    firstSymbolLayer,
  );

  addLayerIfMissing(
    map,
    {
      id: ROOF_LAYER_ID,
      type: "fill-extrusion",
      source,
      "source-layer": "building",
      minzoom: 15.3,
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          height,
          0,
          "#706a62",
          60,
          "#5d6265",
          160,
          "#4a555c",
        ],
        "fill-extrusion-height": ["+", height, ROOF_CAP_HEIGHT],
        "fill-extrusion-base": height,
        "fill-extrusion-opacity": 1,
      },
    } as LayerSpecification,
    firstSymbolLayer,
  );

  return { layerIds: [...MANAGED_LAYER_IDS], mode: "procedural" };
}

export function setBuildingLayersVisible(
  map: MapLibreMap,
  layerIds: string[],
  visible: boolean,
): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}
