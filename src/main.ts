import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { ensureBuildingExtrusions, setBuildingExtrusionsVisible } from "./map/buildings";
import { DEFAULT_PRESET, PRESETS } from "./map/presets";

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

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
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  "bottom-right",
);

let buildingLayerIds: string[] = [];
let buildingsVisible = true;

function updateBuildingButton(): void {
  buildingsToggle.setAttribute("aria-pressed", String(buildingsVisible));
  buildingsToggle.textContent = `3D buildings: ${buildingsVisible ? "on" : "off"}`;
}

function installBuildingLayers(): void {
  buildingLayerIds = ensureBuildingExtrusions(map);
  setBuildingExtrusionsVisible(map, buildingLayerIds, buildingsVisible);

  status.textContent =
    buildingLayerIds.length > 0
      ? `OpenFreeMap loaded · ${buildingLayerIds.length} 3D building layer${buildingLayerIds.length === 1 ? "" : "s"}`
      : "OpenFreeMap loaded · no building layer found at this zoom/style";
}

map.on("load", installBuildingLayers);

map.on("error", (event) => {
  const message = event.error?.message ?? "Unknown map error";
  status.textContent = `Map error: ${message}`;
});

buildingsToggle.addEventListener("click", () => {
  buildingsVisible = !buildingsVisible;
  setBuildingExtrusionsVisible(map, buildingLayerIds, buildingsVisible);
  updateBuildingButton();
});

resetView.addEventListener("click", () => {
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
  status.textContent = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} · z${map.getZoom().toFixed(1)}`;
});

map.on("click", (event) => {
  const building = map
    .queryRenderedFeatures(event.point)
    .find((feature) => feature.sourceLayer === "building");

  if (!building) {
    featureInfo.textContent = "No rendered building was found under the pointer.";
    return;
  }

  const properties = building.properties ?? {};
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

  featureInfo.textContent =
    Object.keys(usefulProperties).length > 0
      ? JSON.stringify(usefulProperties, null, 2)
      : "Building geometry is present, but this tile exposes none of the inspected properties.";
});

updateBuildingButton();
