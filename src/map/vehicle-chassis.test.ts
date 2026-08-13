import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHASSIS_CONFIG,
  normalizeChassisControls,
} from "./vehicle-chassis";

describe("vehicle chassis helpers", () => {
  it("clamps user controls to their supported ranges", () => {
    expect(normalizeChassisControls({ throttle: 3, steer: -2, brake: 4 })).toEqual({
      throttle: 1,
      steer: -1,
      brake: 1,
    });
  });

  it("keeps a realistic metre-scale validation chassis", () => {
    expect(DEFAULT_CHASSIS_CONFIG.massKg).toBeGreaterThan(1000);
    expect(DEFAULT_CHASSIS_CONFIG.widthMeters).toBeGreaterThan(1.5);
    expect(DEFAULT_CHASSIS_CONFIG.lengthMeters).toBeGreaterThan(3.5);
    expect(DEFAULT_CHASSIS_CONFIG.friction).toBeLessThan(0.6);
  });
});
