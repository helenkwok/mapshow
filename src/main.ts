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
import type { DrivingSide } from "./map/road-lanes";
import { buildRoadWorld, type RoadWorld } from "./map/road-world";
import { RoadSurfaceLayer, type RoadSurfaceStats } from "./map/road-surface-layer";
import { FloatingOriginController } from "./map/floating-origin";
import { RoadPhysicsAdapter, type PhysicsSyncBatch } from "./map/physics-adapter";
import { RapierPhysicsWorld, type RapierPhysicsStats } from "./map/rapier-physics";
import { RapierDebugLayer } from "./map/rapier-debug-layer";

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const LOD3_MIN_ZOOM = 16.1;
const LOD3_RADIUS_METERS = 260;
const LOD3_MAX_BUILDINGS = 24;
const TERRAIN_EXAGGERATION = 1;
const ROAD_SURFACE_MIN_ZOOM = 14.5;
const ROAD_SURFACE_RADIUS_METERS = 650;
const ROAD_SURFACE_MAX_SEGMENTS = 240;
const PHYSICS_ORIGIN_SHIFT_METERS = 400;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Mapshow UI element not found: ${selector}`);
  return element;
}

const status = requiredElement<HTMLDivElement>("#status");
const featureInfo = requiredElement<HTMLDivElement>("#feature-info");
const buildingsToggle = requiredElement<HTMLButtonElement>("#buildings-toggle");
const terrainToggle = requiredElement<HTMLButtonElement>("#terrain-toggle");
const roadsToggle = requiredElement<HTMLButtonElement>("#roads-toggle");
const trafficToggle = requiredElement<HTMLButtonElement>("#traffic-toggle");
const physicsDebugToggle = requiredElement<HTMLButtonElement>("#physics-debug-toggle");
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
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

const buildingDetailLayer = new BuildingDetailLayer();
const roadSurfaceLayer = new RoadSurfaceLayer();
const floatingOrigin = new FloatingOriginController(PHYSICS_ORIGIN_SHIFT_METERS);
const roadPhysics = new RoadPhysicsAdapter();
const rapierPhysics = new RapierPhysicsWorld();
const rapierDebugLayer = new RapierDebugLayer(rapierPhysics);
let buildingLayerIds: string[] = [];
let buildingsVisible = true;
let terrainEnabled = true;
let roadSurfacesEnabled = true;
let physicsDebugVisible = false;
let drivingSide: DrivingSide = DEFAULT_PRESET.drivingSide;
let buildingMode: "procedural" | "style" | "none" = "none";
let lastLod3Candidates = 0;
let gameRoadSource: GameRoadSourceInstallation = { enabled: false, debugVisible: false };
let physicsStats: PhysicsSyncBatch = {
  originRevision: 0,
  created: [],
  updated: [],
  removed: [],
  activeColliders: 0,
  triangleCount: 0,
};
let rapierStats: RapierPhysicsStats = {
  initialized: false,
  activeColliders: 0,
  triangleCount: 0,
  created: 0,
  updated: 0,
  removed: 0,
  lastSubsteps: 0,
  totalSubsteps: 0,
};
let roadStats: RoadSurfaceStats = {
  activeSegments: 0,
  graphNodes: 0,
  directedArcs: 0,
  activeLanes: 0,
  candidateLaneConnections: 0,
  laneConnections: 0,
  filteredByTurnLanes: 0,
  filteredByRestrictions: 0,
  unenforcedRestrictions: 0,
  intersectionPolygons: 0,
  collisionBodies: 0,
  collisionTriangles: 0,
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

function updateTrafficButton(): void {
  trafficToggle.setAttribute("aria-pressed", String(drivingSide === "left"));
  trafficToggle.textContent = `Traffic: ${drivingSide}`;
}

function updatePhysicsDebugButton(): void {
  physicsDebugToggle.disabled = !rapierStats.initialized;
  physicsDebugToggle.setAttribute("aria-pressed", String(physicsDebugVisible));
  physicsDebugToggle.textContent = rapierStats.initialized
    ? `Physics debug: ${physicsDebugVisible ? "on" : "off"}`
    : "Physics debug: loading";
}

function installWorldTerrain(): void {
  installTerrain(map, AWS_TERRARIUM_PROVIDER);
  setTerrainEnabled(map, terrainEnabled, TERRAIN_EXAGGERATION);
}

function installGameRoadWorld(): void {
  gameRoadSource = installGameRoadSource(map);
  const firstSymbolLayer = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
  if (!map.getLayer(roadSurfaceLayer.id)) map.addLayer(roadSurfaceLayer, firstSymbolLayer);
  if (!map.getLayer(rapierDebugLayer.id)) map.addLayer(rapierDebugLayer, firstSymbolLayer);
  updateRoadButton();
}

function installBuildingLayers(): void {
  const installation = installProceduralBuildings(map);
  buildingLayerIds = installation.layerIds;
  buildingMode = installation.mode;
  setBuildingLayersVisible(map, buildingLayerIds, buildingsVisible);

  const firstSymbolLayer = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
  if (!map.getLayer(buildingDetailLayer.id)) map.addLayer(buildingDetailLayer, firstSymbolLayer);
}

function terrainGroundElevation(center: LngLatTuple): number {
  return terrainEnabled ? terrainElevationAt(map, center) : 0;
}

function cameraAnchor(): LngLatTuple {
  const center = map.getCenter();
  return [center.lng, center.lat];
}

function resetFloatingOrigin(): void {
  const anchor = cameraAnchor();
  const frame = floatingOrigin.reset(anchor, terrainGroundElevation(anchor));
  rapierDebugLayer.setFrame(frame);
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

  const cameraCenter = cameraAnchor();
  const deduplicated = new Map<string, BuildingCandidate>();

  for (const feature of map.queryRenderedFeatures()) {
    if (feature.sourceLayer !== "building") continue;
    const candidate = candidateFromFeature(feature, cameraCenter);
    if (!candidate || candidate.distanceMeters > LOD3_RADIUS_METERS) continue;
    candidate.groundElevationMeters = terrainGroundElevation(candidate.center);
    const existing = deduplicated.get(candidate.key);
    if (!existing || candidate.ring.length > existing.ring.length) deduplicated.set(candidate.key, candidate);
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

  const cameraCenter = cameraAnchor();
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
  roadStats = roadSurfaceLayer.setWorld(world, map, terrainEnabled, drivingSide);

  const anchor = cameraAnchor();
  const originUpdate = floatingOrigin.update(anchor, terrainGroundElevation(anchor));
  physicsStats = roadPhysics.sync(roadSurfaceLayer.getCollisionWorld(), originUpdate.frame);
  rapierStats = rapierPhysics.sync(physicsStats);
  rapierDebugLayer.setFrame(originUpdate.frame);
  if (physicsDebugVisible) rapierDebugLayer.refresh();
}

function clearPhysics(): void {
  roadPhysics.clear();
  rapierStats = rapierPhysics.clear();
  physicsStats = {
    ...physicsStats,
    created: [],
    updated: [],
    removed: [],
    activeColliders: 0,
    triangleCount: 0,
  };
  rapierDebugLayer.refresh();
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
      ? ` · roads ${roadStats.activeSegments}/${ROAD_SURFACE_MAX_SEGMENTS} · lanes ${roadStats.activeLanes} · legal turns ${roadStats.laneConnections}/${roadStats.candidateLaneConnections} · Rapier ${rapierStats.activeColliders} colliders/${rapierStats.triangleCount} tris · origin r${physicsStats.originRevision} · ${drivingSide}-traffic`
      : roadSurfacesEnabled && zoom >= ROAD_SURFACE_MIN_ZOOM
        ? " · game roads loading"
        : "";
  const physics = rapierStats.initialized ? " · physics ready" : " · physics loading";
  status.textContent = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} · z${zoom.toFixed(1)}${terrain}${detail}${roads}${physics}`;
}

map.on("load", async () => {
  installWorldTerrain();
  installGameRoadWorld();
  installBuildingLayers();
  updateBuildingButton();
  updateTerrainButton();
  updateRoadButton();
  updateTrafficButton();
  updatePhysicsDebugButton();
  updateStatus();

  try {
    await rapierPhysics.init();
    rapierStats = rapierPhysics.clear();
    resetFloatingOrigin();
  } catch (error) {
    console.error("Rapier initialization failed", error);
  }

  refreshLod3Stream();
  refreshRoadSurfaces();
  updatePhysicsDebugButton();
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
  } else refreshLod3Stream();
  updateBuildingButton();
  updateStatus();
});

terrainToggle.addEventListener("click", () => {
  terrainEnabled = !terrainEnabled;
  setTerrainEnabled(map, terrainEnabled, TERRAIN_EXAGGERATION);
  resetFloatingOrigin();
  refreshLod3Stream();
  refreshRoadSurfaces();
  updateTerrainButton();
  updateStatus();
});

roadsToggle.addEventListener("click", () => {
  if (!gameRoadSource.enabled) return;
  roadSurfacesEnabled = !roadSurfacesEnabled;
  if (!roadSurfacesEnabled) {
    roadSurfaceLayer.clear();
    clearPhysics();
  } else refreshRoadSurfaces();
  updateRoadButton();
  updateStatus();
});

trafficToggle.addEventListener("click", () => {
  drivingSide = drivingSide === "left" ? "right" : "left";
  refreshRoadSurfaces();
  updateTrafficButton();
  updateStatus();
});

physicsDebugToggle.addEventListener("click", () => {
  if (!rapierStats.initialized) return;
  physicsDebugVisible = !physicsDebugVisible;
  rapierDebugLayer.setEnabled(physicsDebugVisible);
  updatePhysicsDebugButton();
  updateStatus();
});

resetView.addEventListener("click", () => {
  buildingDetailLayer.clear();
  roadSurfaceLayer.clear();
  clearPhysics();
  lastLod3Candidates = 0;
  drivingSide = DEFAULT_PRESET.drivingSide;
  updateTrafficButton();
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
  clearPhysics();
  lastLod3Candidates = 0;
  drivingSide = preset.drivingSide;
  updateTrafficButton();
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
  const candidate = candidateFromFeature(building, cameraAnchor());
  if (candidate) candidate.groundElevationMeters = terrainGroundElevation(candidate.center);
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
              laneCenterlines: roadStats.activeLanes,
              candidateLaneConnections: roadStats.candidateLaneConnections,
              legalLaneConnections: roadStats.laneConnections,
              filteredByTurnLanes: roadStats.filteredByTurnLanes,
              filteredByRestrictions: roadStats.filteredByRestrictions,
              preservedButUnenforcedRestrictions: roadStats.unenforcedRestrictions,
              intersectionPolygons: roadStats.intersectionPolygons,
              collisionBodies: roadStats.collisionBodies,
              collisionTriangles: roadStats.collisionTriangles,
              physicsLocalColliders: physicsStats.activeColliders,
              physicsTriangles: physicsStats.triangleCount,
              floatingOriginRevision: physicsStats.originRevision,
              floatingOriginThresholdMeters: PHYSICS_ORIGIN_SHIFT_METERS,
              physicsCoordinateSystem: "x-east, y-up, z-north",
              rapierInitialized: rapierStats.initialized,
              rapierColliders: rapierStats.activeColliders,
              rapierTriangles: rapierStats.triangleCount,
              rapierDebugVisible: physicsDebugVisible,
              drivingSide,
            }
          : "configure VITE_GAME_ROADS_TILEJSON to enable",
      },
      source: usefulProperties,
    },
    null,
    2,
  );
});

window.addEventListener("beforeunload", () => {
  rapierPhysics.dispose();
});

updateBuildingButton();
updateTerrainButton();
updateRoadButton();
updateTrafficButton();
updatePhysicsDebugButton();
