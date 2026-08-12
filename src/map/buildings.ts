import type { Map as MapLibreMap, LayerSpecification } from "maplibre-gl";

const GENERATED_LAYER_ID = "mapshow-buildings-3d";

type VectorLayer = LayerSpecification & {
  source?: string;
  "source-layer"?: string;
};

function isBuildingLayer(layer: LayerSpecification): layer is VectorLayer {
  const candidate = layer as VectorLayer;
  return candidate["source-layer"] === "building" && typeof candidate.source === "string";
}

export function ensureBuildingExtrusions(map: MapLibreMap): string[] {
  const layers = map.getStyle().layers ?? [];
  const existing = layers
    .filter(
      (layer) =>
        layer.type === "fill-extrusion" &&
        (layer as VectorLayer)["source-layer"] === "building",
    )
    .map((layer) => layer.id);

  if (existing.length > 0) {
    return existing;
  }

  const sourceLayer = layers.find(isBuildingLayer);
  if (!sourceLayer?.source) {
    return [];
  }

  const firstSymbolLayer = layers.find((layer) => layer.type === "symbol")?.id;

  map.addLayer(
    {
      id: GENERATED_LAYER_ID,
      type: "fill-extrusion",
      source: sourceLayer.source,
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "render_height"], 8],
          0,
          "#ddd8cf",
          30,
          "#c7c2b9",
          100,
          "#aaa8a4",
          250,
          "#8e9093",
        ],
        "fill-extrusion-height": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          0,
          15.2,
          ["coalesce", ["get", "render_height"], 8],
        ],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.9,
      },
    },
    firstSymbolLayer,
  );

  return [GENERATED_LAYER_ID];
}

export function setBuildingExtrusionsVisible(
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
