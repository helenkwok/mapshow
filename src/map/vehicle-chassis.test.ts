import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHASSIS_CONFIG,
  computeChassisActuation,
  horizontalForwardFromQuaternion,
  normalizeChassisControls,
} from "./vehicle-chassis";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

describe("vehicle chassis helpers", () => {
  it("clamps user controls to their supported ranges", () => {
    expect(normalizeChassisControls({ throttle: 3, steer: -2, brake: 4 })).toEqual({
      throttle: 1,
      steer: -1,
      brake: 1,
    });
  });

  it("uses local +Z as forward for identity rotation", () => {
    expect(horizontalForwardFromQuaternion(IDENTITY)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("rotates forward into +X after a positive 90 degree yaw", () => {
    const half = Math.SQRT1_2;
    const forward = horizontalForwardFromQuaternion({ x: 0, y: half, z: 0, w: half });
    expect(forward.x).toBeCloseTo(1, 9);
    expect(forward.z).toBeCloseTo(0, 9);
  });

  it("applies forward thrust and yaw torque without vertical force", () => {
    const actuation = computeChassisActuation(
      IDENTITY,
      { x: 0, y: 0, z: 0 },
      { throttle: 1, steer: 1, brake: 0 },
    );

    expect(actuation.force).toEqual({ x: 0, y: 0, z: DEFAULT_CHASSIS_CONFIG.maxForwardForceN });
    expect(actuation.torque.x).toBe(0);
    expect(actuation.torque.y).toBeCloseTo(DEFAULT_CHASSIS_CONFIG.maxYawTorqueNm * 0.25, 9);
    expect(actuation.torque.z).toBe(0);
  });

  it("brakes opposite horizontal velocity", () => {
    const actuation = computeChassisActuation(
      IDENTITY,
      { x: 3, y: -4, z: 4 },
      { throttle: 0, steer: 0, brake: 1 },
    );

    expect(actuation.force.x).toBeLessThan(0);
    expect(actuation.force.z).toBeLessThan(0);
    expect(actuation.force.y).toBe(0);
    expect(Math.hypot(actuation.force.x, actuation.force.z)).toBeLessThanOrEqual(
      DEFAULT_CHASSIS_CONFIG.maxBrakeForceN,
    );
  });
});
