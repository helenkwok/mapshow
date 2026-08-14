import { describe, expect, it } from "vitest";
import {
  GAME_ROAD_DEBUG_LAYER_ID,
  GAME_ROAD_SOURCE_ID,
  GAME_ROAD_SOURCE_LAYER,
  gameRoadCarrierLayer,
} from "./game-roads";

describe("game-road carrier layer", () => {
  it("keeps the MapLibre source active when debug rendering is off", () => {
    const layer = gameRoadCarrierLayer(false);

    expect(layer.id).toBe(GAME_ROAD_DEBUG_LAYER_ID);
    expect("source" in layer ? layer.source : undefined).toBe(GAME_ROAD_SOURCE_ID);
    expect("source-layer" in layer ? layer["source-layer"] : undefined).toBe(GAME_ROAD_SOURCE_LAYER);
    expect(layer.layout?.visibility).toBe("visible");
    expect(layer.paint?.["line-opacity"]).toBe(0);
  });

  it("shows the diagnostic line without changing source activation", () => {
    const layer = gameRoadCarrierLayer(true);

    expect(layer.layout?.visibility).toBe("visible");
    expect(layer.paint?.["line-opacity"]).toBe(0.8);
  });
});
