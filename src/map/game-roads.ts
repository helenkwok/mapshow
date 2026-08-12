import type {
  GeoJSONFeature,
  LayerSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
} from "maplibre-gl";

export const GAME_ROAD_SOURCE_ID = "mapshow-game-roads";
export const GAME_ROAD_SOURCE_LAYER = "game_road";
export const GAME_ROAD_DEBUG_LAYER_ID = "mapshow-game-roads-debug";
export const GAME_ROAD_SCHEMA_VERSION = 2;

export type GameRoadFeature = GeoJSONFeature | MapGeoJSONFeature;

export interface GameRoadRecord {
  schemaVersion: number;
  segmentId: number;
  osmId: number;
  highway: string;
  roadClass: string;
  name?: string;
  ref?: string;
  access?: string;
  vehicle?: string;
  motorVehicle?: string;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  speedKmh?: number;
  speedForwardKmh?: number;
  speedBackwardKmh?: number;
  widthM: number;
  widthSource: "tag" | "lanes" | "class_default";
  surface?: string;
  surfaceClass: "paved" | "unpaved" | "unknown";
  smoothness?: string;
  junction?: string;
  oneway: -1 | 0 | 1;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  priority: number;
  firstNode: number;
  lastNode: number;
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

function featureSourceLayer(feature: GameRoadFeature): string | undefined {
  return "sourceLayer" in feature ? feature.sourceLayer : undefined;
}

export function gameRoadFromFeature(feature: GameRoadFeature): GameRoadRecord | null {
  // queryRenderedFeatures() exposes sourceLayer while querySourceFeatures() does not; callers of the latter
  // already constrain the query to GAME_ROAD_SOURCE_LAYER.
  const sourceLayer = featureSourceLayer(feature);
  if (sourceLayer !== undefined && sourceLayer !== GAME_ROAD_SOURCE_LAYER) return null;

  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const schemaVersion = numberProperty(properties, "schema_version");
  const segmentId = numberProperty(properties, "segment_id");
  const osmId = numberProperty(properties, "osm_id");
  const highway = stringProperty(properties, "highway");
  const roadClass = stringProperty(properties, "road_class");
  const widthM = numberProperty(properties, "width_m");
  const widthSource = stringProperty(properties, "width_source");
  const surfaceClass = stringProperty(properties, "surface_class");
  const oneway = numberProperty(properties, "oneway");
  const layer = numberProperty(properties, "layer");
  const priority = numberProperty(properties, "priority");
  const firstNode = numberProperty(properties, "first_node");
  const lastNode = numberProperty(properties, "last_node");
  const nodeCount = numberProperty(properties, "node_count");

  if (
    schemaVersion !== GAME_ROAD_SCHEMA_VERSION ||
    segmentId === undefined ||
    osmId === undefined ||
    !highway ||
    !roadClass ||
    widthM === undefined ||
    !["tag", "lanes", "class_default"].includes(widthSource ?? "") ||
    !["paved", "unpaved", "unknown"].includes(surfaceClass ?? "") ||
    ![-1, 0, 1].includes(oneway ?? Number.NaN) ||
    layer === undefined ||
    priority === undefined ||
    firstNode === undefined ||
    lastNode === undefined ||
    nodeCount === undefined
  ) {
    return null;
  }

  return {
    schemaVersion,
    segmentId,
    osmId,
    highway,
    roadClass,
    name: stringProperty(properties, "name"),
    ref: stringProperty(properties, "ref"),
    access: stringProperty(properties, "access"),
    vehicle: stringProperty(properties, "vehicle"),
    motorVehicle: stringProperty(properties, "motor_vehicle"),
    lanes: numberProperty(properties, "lanes"),
    lanesForward: numberProperty(properties, "lanes_forward"),
    lanesBackward: numberProperty(properties, "lanes_backward"),
    speedKmh: numberProperty(properties, "speed_kmh"),
    speedForwardKmh: numberProperty(properties, "speed_forward_kmh"),
    speedBackwardKmh: numberProperty(properties, "speed_backward_kmh"),
    widthM,
    widthSource: widthSource as GameRoadRecord["widthSource"],
    surface: stringProperty(properties, "surface"),
    surfaceClass: surfaceClass as GameRoadRecord["surfaceClass"],
    smoothness: stringProperty(properties, "smoothness"),
    junction: stringProperty(properties, "junction"),
    oneway: oneway as -1 | 0 | 1,
    bridge: booleanProperty(properties, "bridge"),
    tunnel: booleanProperty(properties, "tunnel"),
    layer,
    priority,
    firstNode,
    lastNode,
    nodeCount,
  };
}

/** Access restrictions are retained for routing policy; only explicit motor/vehicle/access=no is excluded here. */
export function isMotorRoad(record: GameRoadRecord): boolean {
  if (record.motorVehicle?.toLowerCase() === "no") return false;
  if (record.vehicle?.toLowerCase() === "no") return false;
  if (record.access?.toLowerCase() === "no") return false;
  return true;
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
