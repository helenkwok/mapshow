import { describe, expect, it } from "vitest";
import {
  FloatingOriginController,
  rebaseLocalPhysicsPoint,
  type FloatingOriginFrame,
} from "./floating-origin";

function frame(
  revision: number,
  x: number,
  y: number,
  meterScale: number,
  elevationMeters: number,
): FloatingOriginFrame {
  return {
    revision,
    anchor: [0, 0],
    elevationMeters,
    mercator: { x, y } as FloatingOriginFrame["mercator"],
    meterScale,
  };
}

describe("rebaseLocalPhysicsPoint", () => {
  it("preserves world position across a floating-origin change", () => {
    const from = frame(1, 0, 0, 1, 100);
    const to = frame(2, 10, -5, 1, 90);
    const point = { x: 12, y: 3, z: 4 };

    const rebased = rebaseLocalPhysicsPoint(point, from, to);
    expect(rebased).toEqual({ x: 2, y: 13, z: -1 });

    const roundTrip = rebaseLocalPhysicsPoint(rebased, to, from);
    expect(roundTrip.x).toBeCloseTo(point.x, 9);
    expect(roundTrip.y).toBeCloseTo(point.y, 9);
    expect(roundTrip.z).toBeCloseTo(point.z, 9);
  });

  it("accounts for different metres-to-Mercator scale", () => {
    const from = frame(1, 1, 1, 0.5, 20);
    const to = frame(2, 2, 3, 0.25, 25);
    const rebased = rebaseLocalPhysicsPoint({ x: 4, y: 8, z: 2 }, from, to);

    expect(rebased.x).toBeCloseTo(4, 9);
    expect(rebased.y).toBeCloseTo(3, 9);
    expect(rebased.z).toBeCloseTo(12, 9);
  });
});

describe("FloatingOriginController", () => {
  it("retains the frame below the threshold and shifts after it", () => {
    const controller = new FloatingOriginController(400);
    const first = controller.update([0, 0], 12);
    const near = controller.update([0.0001, 0], 12);
    const far = controller.update([0.01, 0], 14);

    expect(first.shifted).toBe(true);
    expect(first.frame.revision).toBe(1);
    expect(near.shifted).toBe(false);
    expect(near.frame.revision).toBe(1);
    expect(far.shifted).toBe(true);
    expect(far.frame.revision).toBe(2);
    expect(far.frame.elevationMeters).toBe(14);
  });
});
