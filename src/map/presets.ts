export type PlacePreset = {
  label: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
};

export const PRESETS: Record<string, PlacePreset> = {
  adelaide: {
    label: "Adelaide",
    center: [138.6007, -34.9285],
    zoom: 15.6,
    pitch: 62,
    bearing: -18,
  },
  "hong-kong": {
    label: "Hong Kong",
    center: [114.1694, 22.3193],
    zoom: 16,
    pitch: 65,
    bearing: 22,
  },
  manhattan: {
    label: "Manhattan",
    center: [-73.9857, 40.7484],
    zoom: 16.1,
    pitch: 68,
    bearing: -28,
  },
  tokyo: {
    label: "Tokyo",
    center: [139.7671, 35.6812],
    zoom: 15.9,
    pitch: 64,
    bearing: 18,
  },
};

export const DEFAULT_PRESET = PRESETS.adelaide;
