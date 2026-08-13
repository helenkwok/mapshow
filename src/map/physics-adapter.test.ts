import { describe, expect, it } from "vitest";
import type { FloatingOriginFrame } from "./floating-origin";
import { RoadPhysicsAdapter } from "./physics-adapter";
import type { RoadCollisionBody, RoadCollisionWorld } from "./road-collision";

function frame(revision: number, elevationMeters = 8): FloatingOriginFrame {
  return {
    revision,
    anchor: [0, 0],
    elevationMeters,
    mercator: { x: 0.5, y: 0.5 } as FloatingOriginFrame["mercator"],
    meterScale: 0.001,
  };
}

function body(): RoadCollisionBody {
  return {
    bodyId: "road-segment:7:collision",
    kind: "road-segment",
    origin: { x: 0.5, y: 0.5 } as RoadCollisionBody["origin"],
    meterScale: 0.001,
    positions: [
      0, 0, 10,
      1, 0, 10,
      0, 1, 10,
    ],
    indices: [0, 1, 2],
    segmentId: 7,
    surfaceClass: "paved",
  };
}

function world(bodies: RoadCollisionBody[]): RoadCollisionWorld {
  return { bodies, triangleCount: bodies.reduce((sum, item) => sum + item.indices.length / 3, 0) };
}

describe("RoadPhysicsAdapter", () => {
  it("creates local colliders and keeps metadata", () => {
    const adapter = new RoadPhysicsAdapter();
    const batch = adapter.sync(world([body()]), frame(1));

    expect(batch.created).toHaveLength(1);
    expect(batch.updated).toHaveLength(0);
    expect(batch.removed).toHaveLength(0);
    expect(batch.activeColliders).toBe(1);
    expect(batch.triangleCount).toBe(1);
    expect(batch.created[0].segmentId).toBe(7);
    expect(batch.created[0].surfaceClass).toBe("paved");
    expect(batch.created[0].positions).toEqual([
      0, 2, 0,
      1, 2, 0,
      0, 2, -1,
    ]);
  });

  it("does not replace an unchanged collider in the same frame", () => {
    const adapter = new RoadPhysicsAdapter();
    adapter.sync(world([body()]), frame(1));
    const batch = adapter.sync(world([body()]), frame(1));

    expect(batch.created).toHaveLength(0);
    expect(batch.updated).toHaveLength(0);
    expect(batch.removed).toHaveLength(0);
  });

  it("updates all active colliders when the origin revision changes", () => {
    const adapter = new RoadPhysicsAdapter();
    adapter.sync(world([body()]), frame(1, 8));
    const batch = adapter.sync(world([body()]), frame(2, 9));

    expect(batch.created).toHaveLength(0);
    expect(batch.updated).toHaveLength(1);
    expect(batch.updated[0].positions[1]).toBe(1);
  });

  it("reports removal when a streamed body leaves the world", () => {
    const adapter = new RoadPhysicsAdapter();
    adapter.sync(world([body()]), frame(1));
    const batch = adapter.sync(world([]), frame(1));

    expect(batch.removed).toEqual(["road-segment:7:collision"]);
    expect(batch.activeColliders).toBe(0);
    expect(adapter.snapshot()).toHaveLength(0);
  });
});
