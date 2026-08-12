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

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const LOD3_MIN_ZOOM = 16.1;
const LOD3_RADIUS_METERS = 260;
const LOD3_MAX_BUILDINGS = 24;

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
let buildingLayerIds: string[] = [];
let buildingsVisible = true;
let buildingMode: "procedural" | "style" | "none" = "none";
let lastLod3Candidates = 0;

function updateBuildingButton(): void {
  buildingsToggle.setAttribute("aria-pressed", String(buildingsVisible));
  buildingsToggle.textContent = `3D buildings: ${buildingsVisible ? "on" : "off"}`;
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

  if (buildingMode === "procedural") {
    status.textContent =
      "OpenFreeMap loaded · LOD2 façades enabled · LOD3 streams automatically at close zoom";
  } else if (buildingMode === "style") {
    status.textContent = "OpenFreeMap loaded · using style-provided 3D buildings";
  } else {
    status.textContent = "OpenFreeMap loaded · no building layer found in this style";
  }
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
    const existing = deduplicated.get(candidate.key);
    if (!existing || candidate.ring.length > existing.ring.length) {
      deduplicated.set(candidate.key, candidate);
    }
  }

  return [...deduplicated.values()]
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, LOD3_MAX_BUILDINGS);
}

function refreshLod3Stream(): void {
  const candidates = collectLod3Candidates();
  lastLod3Candidates = candidates.length;
  buildingDetailLayer.setBuildings(candidates);
}

function updateStatus(): void {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const detail =
    buildingDetailLayer.activeCount > 0
      ? ` · LOD3 ${buildingDetailLayer.activeCount}/${LOD3_MAX_BUILDINGS} buildings within ${LOD3_RADIUS_METERS} m`
      : zoom >= 15.3 && buildingMode === "procedural"
        ? " · façade LOD2"
        : "";
  status.textContent = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} · z${zoom.toFixed(1)}${detail}`;
}

map.on("load", () => {
  installBuildingLayers();
  refreshLod3Stream();
});

map.on("idle", () => {
  refreshLod3Stream();
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

resetView.addEventListener("click", () => {
  buildingDetailLayer.clear();
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
  updateStatus();
});

map.on("zoomend", () => {
  refreshLod3Stream();
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
        lod3: candidate
          ? {
              key: candidate.key,
              distance: `${candidate.distanceMeters.toFixed(0)} m from camera center`,
              active: candidate.distanceMeters <= LOD3_RADIUS_METERS && map.getZoom() >= LOD3_MIN_ZOOM,
              streamCount: lastLod3Candidates,
              budget: LOD3_MAX_BUILDINGS,
            }
          : "footprint geometry unavailable",
      },
      source: usefulProperties,
    },
    null,
    2,
  );
});

updateBuildingButton();
