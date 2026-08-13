import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUSPENSION_CONFIG,
  buildWheelDefinitions,
  computeRaycastVehicleActuation,
} from "./vehicle-suspension";

describe("raycast vehicle suspension", () => {
  it("builds four symmetric wheels with front steering and rear drive", () => {
    const wheels = buildWheelDefinitions();

    expect(wheels).toHaveLength(4);
    expect(wheels.filter((wheel) => wheel.steer).map((wheel) => wheel.role)).toEqual([
      "front-left",
      "front-right",
    ]);
    expect(wheels.filter((wheel) => wheel.drive).map((wheel) => wheel.role)).toEqual([
      "rear-left",
      "rear-right",
    ]);
    expect(wheels.every((wheel) => wheel.brake)).toBe(true);
    expect(wheels[0].chassisConnection.x).toBeCloseTo(-wheels[1].chassisConnection.x, 9);
    expect(wheels[0].chassisConnection.z).toBeCloseTo(-wheels[2].chassisConnection.z, 9);
  });

  it("splits engine force across driven wheels", () => {
    const output = computeRaycastVehicleActuation(
      { throttle: 1, steer: 0, brake: 0 },
      0,
    );

    expect(output.engineForcePerDrivenWheelN).toBeCloseTo(
      DEFAULT_SUSPENSION_CONFIG.maxForwardEngineForceN / 2,
      9,
    );
  });

  it("reduces steering authority with speed but keeps a minimum", () => {
    const slow = computeRaycastVehicleActuation(
      { throttle: 0, steer: 1, brake: 0 },
      0,
    );
    const fast = computeRaycastVehicleActuation(
      { throttle: 0, steer: 1, brake: 0 },
      100,
    );

    expect(slow.steeringAngleRadians).toBeCloseTo(
      DEFAULT_SUSPENSION_CONFIG.maxSteeringAngleRadians,
      9,
    );
    expect(fast.steeringAngleRadians).toBeCloseTo(
      DEFAULT_SUSPENSION_CONFIG.maxSteeringAngleRadians
        * DEFAULT_SUSPENSION_CONFIG.minimumSteeringFactor,
      9,
    );
  });

  it("maps braking to all-wheel brake impulse and preserves reverse sign", () => {
    const output = computeRaycastVehicleActuation(
      { throttle: -1, steer: 0, brake: 0.5 },
      3,
    );

    expect(output.engineForcePerDrivenWheelN).toBeLessThan(0);
    expect(output.brakeImpulsePerWheel).toBeCloseTo(
      DEFAULT_SUSPENSION_CONFIG.maxBrakeImpulse / 2,
      9,
    );
  });
});
