import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import {
  installProceduralBuildings,
  setBuildingLayersVisible,
} from "./map/buildings";
import { buildingProfileFromProperties } from "./map/building-profile";
import {
  candidateFromFeature,
  type BuildingCandidate,
  type LngLatTuple,
} from "./map/building-feature";
import { BuildingDetailLayer } from "./map/building-detail-layer";
import { DEFAULT_PRESET, PRESETS } from "./map/presets";
import {
  AWS_TERRARIUM_PROVIDER,
  installTerrain,
  setTerrainEnabled,
  terrainElevationAt,
} from "./map/terrain";
import {
  GAME_ROAD_SOURCE_ID,
  GAME_ROAD_SOURCE_LAYER,
  installGameRoadSource,
  type GameRoadSourceInstallation,
} from "./map/game-roads";
import { buildRoadWorld, type RoadWorld } from "./map/road-world";
import { RoadSurfaceLayer, type RoadSurfaceStats } from "./map/road-surface-layer";

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const LOD3_MIN_ZOOM = 16.1;
const LOD3_RADIUS_METERS = 260;
const LOD3_MAX_BUILDINGS = 24;
const TERRAIN_EXAGGERATION = 1;
const ROAD_SURFACE_MIN_ZOOM = 14.5;
const ROAD_SURFACE_RADIUS_METERS = 650;
const ROAD_SURFACE_MAX_SEGMENTS = 240;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Mapshow UI element not found: ${selector}`);
  }
  return element;
}

const status = requiredElement<HTMLDivElement>("#status");
const featureInfo = requiredElement<HTMLDivElement>("#feature-info");
const buildingsToggle = requiredElement<HTMLButtonElement>("#buildings-toggle");
const terrainToggle = requiredElement<HTMLButtonElement>("#terrain-toggle");
const roadsToggle = requiredElement<HTMLButtonElement>("#roads-toggle");
const resetView = requiredElement<HTMLButtonElement>("#reset-view");
const presetButtons = requiredElement<HTMLDivElement>("#preset-buttons");

const map = new maplibregl.Map({
  container: "map",
  style: OPENFREEMAP_STYLE,
  center: DEFAULT_PRESET.center,
  zoom: DEFAULT_PRESET.zoom,
  pitch: DEFAULT_PRESET.pitch,
  bearing: DEFAULT_PRESET.bearing,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  "bottom-right",
);

const buildingDetailLayer = new BuildingDetailLayer();
const roadSurfaceLayer = new RoadSurfaceLayer();
let buildingLayerIds: string[] = [];
let buildingsVisible = true;
let terrainEnabled = true;
let roadSurfacesEnabled = true;
let buildingMode: "procedural" | "style" | "none" = "none";
let lastLod3Candidates = 0;
let gameRoadSource: GameRoadSourceInstallation = { enabled: false, debugVisible: false };
let roadStats: RoadSurfaceStats = {
  activeSegments: 0,
  graphNodes: 0,
  directedArcs: 0,
  created: 0,
  replaced: 0,
  removed: 0,
};

function emptyRoadWorld(): RoadWorld {
  return { segments: [], nodes: new Map(), arcs: [] };
}

function updateBuildingButton(): void {
  buildingsToggle.setAttribute("aria-pressed", String(buildingsVisible));
  buildingsToggle.textContent = `3D buildings: ${buildingsVisible ? "on" : "off"}`;
}

function updateTerrainButton(): void {
  terrainToggle.setAttribute("aria-pressed", String(terrainEnabled));
  terrainToggle.textContent = `Terrain: ${terrainEnabled ? "on" : "off"}`;
}

function updateRoadButton(): void {
  roadsToggle.disabled = !gameRoadSource.enabled;
  roadsToggle.setAttribute("aria-pressed", String(gameRoadSource.enabled && roadSurfacesEnabled));
  roadsToggle.textContent = gameRoadSource.enabled
    ? `Road surfaces: ${roadSurfacesEnabled ? "on" : "off"}`
    : "Road surfaces: configure tiles";
}

function installWorldTerrain(): void {
  installTerrain(map, AWS_TERRARIUM_PROVIDER);
  setTerrainEnabled(map, terrainEnabled, TERRAIN_EXAGGERATION);
}

function installGameRoadWorld(): void {
  gameRoadSource = installGameRoadSource(map);
  const firstSymbolLayer = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
  if (!map.getLayer(roadSurfaceLayer.id)) {
    map.addLayer(roadSurfaceLayer, firstSymbolLayer);
  }
  updateRoadButton();
}

function installBuildingLayers(): void {
  const installation = installProceduralBuildings(map);
  buildingLayerIds = installation.layerIds;
  buildingMode = installation.mode;
  setBuildingLayersVisible(map, buildingLayerIds, buildingsVisible);

  const firstSymbolLayer = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
  if (!map.getLayer(buildingDetailLayer.id)) {
    map.addLayer(buildingDetailLayer, firstSymbolLayer);
  }
}

function terrainGroundElevation(center: LngLatTuple): number {
  return terrainEnabled ? terrainElevationAt(map, center) : 0;
}

function collectLod3Candidates(): BuildingCandidate[] {
  if (
    !buildingsVisible ||
    buildingMode !== "procedural" ||
    map.getZoom() < LOD3_MIN_ZOOM ||
    !map.isStyleLoaded()
  ) {
    return [];
  }

  const center = map.getCenter();
  const cameraCenter: LngLatTuple = [center.lng, center.lat];
  const deduplicated = new Map<string, BuildingCandidate>();

  for (const feature of map.queryRenderedFeatures()) {
    if (feature.sourceLayer !== "building") continue;
    const candidate = candidateFromFeature(feature, cameraCenter);
    if (!candidate || candidate.distanceMeters > LOD3_RADIUS_METERS) continue;
    candidate.groundElevationMeters = terrainGroundElevation(candidate.center);
    const existing = deduplicated.get(candidate.key);
    if (!existing || candidate.ring.length > existing.ring.length) {
      deduplicated.set(candidate.key, candidate);
    }
  }

  return [...deduplicated.values()]
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, LOD3_MAX_BUILDINGS);
}

function collectRoadWorld(): RoadWorld {
  if (
    !gameRoadSource.enabled ||
    !roadSurfacesEnabled ||
    map.getZoom() < ROAD_SURFACE_MIN_ZOOM ||
    !map.isStyleLoaded() ||
    !map.getSource(GAME_ROAD_SOURCE_ID) ||
    !map.isSourceLoaded(GAME_ROAD_SOURCE_ID)
  ) {
    return emptyRoadWorld();
  }

  const center = map.getCenter();
  const cameraCenter: LngLatTuple = [center.lng, center.lat];
  const features = map.querySourceFeatures(GAME_ROAD_SOURCE_ID, {
    sourceLayer: GAME_ROAD_SOURCE_LAYER,
  });
  return buildRoadWorld(
    features,
    cameraCenter,
    ROAD_SURFACE_RADIUS_METERS,
    ROAD_SURFACE_MAX_SEGMENTS,
  );
}

function refreshLod3Stream(): void {
  const candidates = collectLod3Candidates();
  lastLod3Candidates = candidates.length;
  buildingDetailLayer.setBuildings(candidates);
}

function refreshRoadSurfaces(): void {
  const world = collectRoadWorld();
  roadStats = roadSurfaceLayer.setWorld(world, map, terrainEnabled);
}

function updateStatus(): void {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const terrain = terrainEnabled
    ? ` · terrain ${AWS_TERRARIUM_PROVIDER.label}`
    : " · flat terrain";
  const detail =
    buildingDetailLayer.activeCount > 0
      ? ` · LOD3 ${buildingDetailLayer.activeCount}/${LOD3_MAX_BUILDINGS} buildings`
      : zoom >= 15.3 && buildingMode === "procedural"
        ? " · façade LOD2"
        : "";
  const roads = !gameRoadSource.enabled
    ? " · game roads unconfigured"
    : roadStats.activeSegments > 0
      ? ` · roads ${roadStats.activeSegments}/${ROAD_SURFACE_MAX_SEGMENTS} segments · ${roadStats.graphNodes} graph nodes`
      : roadSurfacesEnabled && zoom >= ROAD_SURFACE_MIN_ZOOM
        ? " · game roads loading"
        : "";
  status.textContent = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} · z${zoom.toFixed(1)}${terrain}${detail}${roads}`;
}

map.on("load", () => {
  installWorldTerrain();
  installGameRoadWorld();
  installBuildingLayers();
  refreshLod3Stream();
  refreshRoadSurfaces();
  updateBuildingButton();
  updateTerrainButton();
  updateRoadButton();
  updateStatus();
});

map.on("idle", () => {
  refreshLod3Stream();
  refreshRoadSurfaces();
  updateStatus();
});

map.on("error", (event) => {
  const message = event.error?.message ?? "Unknown map error";
  status.textContent = `Map error: ${message}`;
});

buildingsToggle.addEventListener("click", () => {
  buildingsVisible = !buildingsVisible;
  setBuildingLayersVisible(map, buildingLayerIds, buildingsVisible);
  if (!buildingsVisible) {
    buildingDetailLayer.clear();
    lastLod3Candidates = 0;
  } else {
    refreshLod3Stream();
  }
  updateBuildingButton();
  updateStatus();
});

terrainToggle.addEventListener("click", () => {
  terrainEnabled = !terrainEnabled;
  setTerrainEnabled(map, terrainEnabled, TERRAIN_EXAGGERATION);
  refreshLod3Stream();
  refreshRoadSurfaces();
  updateTerrainButton();
  updateStatus();
});

roadsToggle.addEventListener("click", () => {
  if (!gameRoadSource.enabled) return;
  roadSurfacesEnabled = !roadSurfacesEnabled;
  if (!roadSurfacesEnabled) roadSurfaceLayer.clear();
  else refreshRoadSurfaces();
  updateRoadButton();
  updateStatus();
});

resetView.addEventListener("click", () => {
  buildingDetailLayer.clear();
  roadSurfaceLayer.clear();
  lastLod3Candidates = 0;
  map.easeTo({
    center: DEFAULT_PRESET.center,
    zoom: DEFAULT_PRESET.zoom,
    pitch: DEFAULT_PRESET.pitch,
    bearing: DEFAULT_PRESET.bearing,
    duration: 900,
  });
});

presetButtons.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-preset]");
  if (!button) return;

  const preset = PRESETS[button.dataset.preset ?? ""];
  if (!preset) return;

  buildingDetailLayer.clear();
  roadSurfaceLayer.clear();
  lastLod3Candidates = 0;
  map.flyTo({
    center: preset.center,
    zoom: preset.zoom,
    pitch: preset.pitch,
    bearing: preset.bearing,
    essential: true,
  });
  status.textContent = `Flying to ${preset.label}…`;
});

map.on("moveend", () => {
  refreshLod3Stream();
  refreshRoadSurfaces();
  updateStatus();
});

map.on("zoomend", () => {
  refreshLod3Stream();
  refreshRoadSurfaces();
  updateStatus();
});

map.on("click", (event) => {
  const building = map
    .queryRenderedFeatures(event.point)
    .find((feature) => feature.sourceLayer === "building");

  if (!building) {
    featureInfo.textContent = "No rendered building was found under the pointer.";
    return;
  }

  const properties = (building.properties ?? {}) as Record<string, unknown>;
  const profile = buildingProfileFromProperties(properties);
  const center = map.getCenter();
  const candidate = candidateFromFeature(building, [center.lng, center.lat]);
  if (candidate) {
    candidate.groundElevationMeters = terrainGroundElevation(candidate.center);
  }
  const usefulProperties = Object.fromEntries(
    [
      "name",
      "class",
      "render_height",
      "render_min_height",
      "building",
      "building:levels",
      "osm_id",
    ]
      .filter((key) => properties[key] !== undefined)
      .map((key) => [key, properties[key]]),
  );

  featureInfo.textContent = JSON.stringify(
    {
      mapshow: {
        facade: profile.facade,
        height: `${profile.height.toFixed(1)} m`,
        minHeight: `${profile.minHeight.toFixed(1)} m`,
        estimatedLevels: profile.estimatedLevels,
        groundElevation: candidate
          ? `${candidate.groundElevationMeters.toFixed(1)} m DEM`
          : "unavailable",
        terrainProvider: terrainEnabled ? AWS_TERRARIUM_PROVIDER.label : "disabled",
        lod3: candidate
          ? {
              key: candidate.key,
              distance: `${candidate.distanceMeters.toFixed(0)} m from camera center`,
              active: candidate.distanceMeters <= LOD3_RADIUS_METERS && map.getZoom() >= LOD3_MIN_ZOOM,
              streamCount: lastLod3Candidates,
              budget: LOD3_MAX_BUILDINGS,
            }
          : "footprint geometry unavailable",
        roadWorld: gameRoadSource.enabled
          ? {
              surfaceSegments: roadStats.activeSegments,
              graphNodes: roadStats.graphNodes,
              directedArcs: roadStats.directedArcs,
            }
          : "configure VITE_GAME_ROADS_TILEJSON to enable",
      },
      source: usefulProperties,
    },
    null,
    2,
  );
});

updateBuildingButton();
updateTerrainButton();
updateRoadButton();
