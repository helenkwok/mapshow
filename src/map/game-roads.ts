import type { LayerSpecification, Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";

export const GAME_ROAD_SOURCE_ID = "mapshow-game-roads";
export const GAME_ROAD_SOURCE_LAYER = "game_road";
export const GAME_ROAD_DEBUG_LAYER_ID = "mapshow-game-roads-debug";

export interface GameRoadRecord {
  osmId: number;
  highway: string;
  roadClass: string;
  name?: string;
  ref?: string;
  lanes?: number;
  speedKmh?: number;
  widthM: number;
  widthSource: "tag" | "lanes" | "class_default";
  surface?: string;
  surfaceClass: "paved" | "unpaved" | "unknown";
  oneway: -1 | 0 | 1;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  firstNode?: number;
  lastNode?: number;
  nodeCount: number;
}

export interface GameRoadSourceInstallation {
  enabled: boolean;
  tilejson?: string;
  debugVisible: boolean;
}

function numberProperty(properties: Record<string, unknown>, key: string): number | undefined {
  const value = properties[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringProperty(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? undefined
    : String(value);
}

function booleanProperty(properties: Record<string, unknown>, key: string): boolean {
  const value = properties[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "yes", "1"].includes(String(value).toLowerCase());
}

export function gameRoadFromFeature(feature: MapGeoJSONFeature): GameRoadRecord | null {
  if (feature.sourceLayer !== GAME_ROAD_SOURCE_LAYER) return null;
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const osmId = numberProperty(properties, "osm_id");
  const highway = stringProperty(properties, "highway");
  const roadClass = stringProperty(properties, "road_class");
  const widthM = numberProperty(properties, "width_m");
  const widthSource = stringProperty(properties, "width_source");
  const surfaceClass = stringProperty(properties, "surface_class");
  const oneway = numberProperty(properties, "oneway");
  const layer = numberProperty(properties, "layer");
  const nodeCount = numberProperty(properties, "node_count");

  if (
    osmId === undefined ||
    !highway ||
    !roadClass ||
    widthM === undefined ||
    !["tag", "lanes", "class_default"].includes(widthSource ?? "") ||
    !["paved", "unpaved", "unknown"].includes(surfaceClass ?? "") ||
    ![-1, 0, 1].includes(oneway ?? Number.NaN) ||
    layer === undefined ||
    nodeCount === undefined
  ) {
    return null;
  }

  return {
    osmId,
    highway,
    roadClass,
    name: stringProperty(properties, "name"),
    ref: stringProperty(properties, "ref"),
    lanes: numberProperty(properties, "lanes"),
    speedKmh: numberProperty(properties, "speed_kmh"),
    widthM,
    widthSource: widthSource as GameRoadRecord["widthSource"],
    surface: stringProperty(properties, "surface"),
    surfaceClass: surfaceClass as GameRoadRecord["surfaceClass"],
    oneway: oneway as -1 | 0 | 1,
    bridge: booleanProperty(properties, "bridge"),
    tunnel: booleanProperty(properties, "tunnel"),
    layer,
    firstNode: numberProperty(properties, "first_node"),
    lastNode: numberProperty(properties, "last_node"),
    nodeCount,
  };
}

export function installGameRoadSource(map: MapLibreMap): GameRoadSourceInstallation {
  const tilejson = import.meta.env.VITE_GAME_ROADS_TILEJSON?.trim();
  const debugVisible = import.meta.env.VITE_GAME_ROADS_DEBUG === "true";
  if (!tilejson) return { enabled: false, debugVisible: false };

  if (!map.getSource(GAME_ROAD_SOURCE_ID)) {
    map.addSource(GAME_ROAD_SOURCE_ID, {
      type: "vector",
      url: tilejson,
    });
  }

  if (!map.getLayer(GAME_ROAD_DEBUG_LAYER_ID)) {
    const firstSymbolLayer = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
    map.addLayer(
      {
        id: GAME_ROAD_DEBUG_LAYER_ID,
        type: "line",
        source: GAME_ROAD_SOURCE_ID,
        "source-layer": GAME_ROAD_SOURCE_LAYER,
        minzoom: 12,
        layout: {
          visibility: debugVisible ? "visible" : "none",
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#ff6b35",
          "line-width": 2,
          "line-opacity": 0.8,
        },
      } as LayerSpecification,
      firstSymbolLayer,
    );
  }

  return { enabled: true, tilejson, debugVisible };
}

export function setGameRoadDebugVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(GAME_ROAD_DEBUG_LAYER_ID)) {
    map.setLayoutProperty(GAME_ROAD_DEBUG_LAYER_ID, "visibility", visible ? "visible" : "none");
  }
}
