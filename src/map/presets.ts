export type PlacePreset = {
  label: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  drivingSide: "left" | "right";
};

export const PRESETS: Record<string, PlacePreset> = {
  adelaide: {
    label: "Adelaide",
    center: [138.6007, -34.9285],
    zoom: 15.6,
    pitch: 62,
    bearing: -18,
    drivingSide: "left",
  },
  "hong-kong": {
    label: "Hong Kong",
    center: [114.1694, 22.3193],
    zoom: 16,
    pitch: 65,
    bearing: 22,
    drivingSide: "left",
  },
  manhattan: {
    label: "Manhattan",
    center: [-73.9857, 40.7484],
    zoom: 16.1,
    pitch: 68,
    bearing: -28,
    drivingSide: "right",
  },
  tokyo: {
    label: "Tokyo",
    center: [139.7671, 35.6812],
    zoom: 15.9,
    pitch: 64,
    bearing: 18,
    drivingSide: "left",
  },
};

function queryNumber(
  params: URLSearchParams,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function viewOverride(base: PlacePreset): PlacePreset | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const lat = queryNumber(params, "lat", -85, 85);
  const lng = queryNumber(params, "lng", -180, 180);
  if (lat === undefined || lng === undefined) return undefined;

  return {
    ...base,
    label: "Custom view",
    center: [lng, lat],
    zoom: queryNumber(params, "zoom", 0, 24) ?? base.zoom,
    pitch: queryNumber(params, "pitch", 0, 85) ?? base.pitch,
    bearing: queryNumber(params, "bearing", -360, 360) ?? base.bearing,
  };
}

// URL view parameters make visual regressions and bug reports deterministic without exposing the
// MapLibre instance as a test-only global. Normal launches continue to use the Adelaide preset.
export const DEFAULT_PRESET = viewOverride(PRESETS.adelaide) ?? PRESETS.adelaide;
