import { describe, expect, it } from "vitest";
import {
  GAME_ROAD_DEBUG_LAYER_ID,
  GAME_ROAD_SOURCE_ID,
  GAME_ROAD_SOURCE_LAYER,
  gameRoadCarrierLayer,
} from "./game-roads";

function expectLineCarrier(debugVisible: boolean) {
  const layer = gameRoadCarrierLayer(debugVisible);
  expect(layer.type).toBe("line");
  if (layer.type !== "line") throw new Error("game-road carrier must be a line layer");
  return layer;
}

describe("game-road carrier layer", () => {
  it("keeps the MapLibre source active when debug rendering is off", () => {
    const layer = expectLineCarrier(false);

    expect(layer.id).toBe(GAME_ROAD_DEBUG_LAYER_ID);
    expect(layer.source).toBe(GAME_ROAD_SOURCE_ID);
    expect(layer["source-layer"]).toBe(GAME_ROAD_SOURCE_LAYER);
    expect(layer.layout?.visibility).toBe("visible");
    expect(layer.paint?.["line-opacity"]).toBe(0);
  });

  it("shows the diagnostic line without changing source activation", () => {
    const layer = expectLineCarrier(true);

    expect(layer.layout?.visibility).toBe("visible");
    expect(layer.paint?.["line-opacity"]).toBe(0.8);
  });
});
