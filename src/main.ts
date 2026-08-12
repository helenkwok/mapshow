import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import {
  installProceduralBuildings,
  setBuildingLayersVisible,
} from "./map/buildings";
import { buildingProfileFromProperties } from "./map/building-profile";
import { DEFAULT_PRESET, PRESETS } from "./map/presets";
import {
  SelectedBuildingLayer,
  type LngLatTuple,
} from "./map/selected-building-layer";

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Mapshow UI element not found: ${selector}`);
  }
  return element;
}

function isLngLatTuple(value: unknown): value is LngLatTuple {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function asRing(value: unknown): LngLatTuple[] | null {
  if (!Array.isArray(value)) return null;
  const ring = value.filter(isLngLatTuple);
  return ring.length >= 4 ? ring : null;
}

function ringArea(ring: LngLatTuple[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area / 2);
}

function outerRingFromGeometry(geometry: {
  type: string;
  coordinates?: unknown;
}): LngLatTuple[] | null {
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return asRing(geometry.coordinates[0]);
  }

  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    const rings = geometry.coordinates
      .map((polygon) => (Array.isArray(polygon) ? asRing(polygon[0]) : null))
      .filter((ring): ring is LngLatTuple[] => ring !== null);
    return rings.sort((a, b) => ringArea(b) - ringArea(a))[0] ?? null;
  }

  return null;
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

const selectedBuildingLayer = new SelectedBuildingLayer();
let buildingLayerIds: string[] = [];
let buildingsVisible = true;
let buildingMode: "procedural" | "style" | "none" = "none";
let hasLod3Selection = false;

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
  if (!map.getLayer(selectedBuildingLayer.id)) {
    map.addLayer(selectedBuildingLayer, firstSymbolLayer);
  }

  if (buildingMode === "procedural") {
    status.textContent =
      "OpenFreeMap loaded · LOD2 façades enabled · click a building for LOD3 geometry";
  } else if (buildingMode === "style") {
    status.textContent = "OpenFreeMap loaded · using style-provided 3D buildings";
  } else {
    status.textContent = "OpenFreeMap loaded · no building layer found in this style";
  }
}

map.on("load", installBuildingLayers);

map.on("error", (event) => {
  const message = event.error?.message ?? "Unknown map error";
  status.textContent = `Map error: ${message}`;
});

buildingsToggle.addEventListener("click", () => {
  buildingsVisible = !buildingsVisible;
  setBuildingLayersVisible(map, buildingLayerIds, buildingsVisible);
  if (!buildingsVisible) {
    selectedBuildingLayer.clearSelection();
    hasLod3Selection = false;
  }
  updateBuildingButton();
});

resetView.addEventListener("click", () => {
  selectedBuildingLayer.clearSelection();
  hasLod3Selection = false;
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

  selectedBuildingLayer.clearSelection();
  hasLod3Selection = false;
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
  const center = map.getCenter();
  const detail = hasLod3Selection
    ? " · selected-building LOD3"
    : map.getZoom() >= 15.3 && buildingMode === "procedural"
      ? " · façade LOD2"
      : "";
  status.textContent = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} · z${map.getZoom().toFixed(1)}${detail}`;
});

map.on("click", (event) => {
  const building = map
    .queryRenderedFeatures(event.point)
    .find((feature) => feature.sourceLayer === "building");

  if (!building) {
    selectedBuildingLayer.clearSelection();
    hasLod3Selection = false;
    featureInfo.textContent = "No rendered building was found under the pointer.";
    return;
  }

  const properties = (building.properties ?? {}) as Record<string, unknown>;
  const profile = buildingProfileFromProperties(properties);
  const ring = outerRingFromGeometry(
    building.geometry as { type: string; coordinates?: unknown },
  );

  if (ring && buildingsVisible) {
    selectedBuildingLayer.setSelection({ ring, profile });
    hasLod3Selection = true;
  } else {
    selectedBuildingLayer.clearSelection();
    hasLod3Selection = false;
  }

  const usefulProperties = Object.fromEntries(
    [
      "name",
      "class",
      "render_height",
      "render_min_height",
      "building",
      "building:levels",
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
        lod3: ring
          ? "generated windows, frames, entrance and roof geometry"
          : "footprint geometry unavailable",
      },
      source: usefulProperties,
    },
    null,
    2,
  );
});

updateBuildingButton();
