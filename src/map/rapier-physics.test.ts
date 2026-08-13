import { afterEach, describe, expect, it } from "vitest";
import type { PhysicsSyncBatch, StaticTriMeshCollider } from "./physics-adapter";
import { RapierPhysicsWorld } from "./rapier-physics";

function groundCollider(): StaticTriMeshCollider {
  return {
    colliderId: "test-ground",
    kind: "road-segment",
    positions: [
      -30, 0, -30,
      30, 0, -30,
      30, 0, 30,
      -30, 0, 30,
    ],
    indices: [0, 2, 1, 0, 3, 2],
    surfaceClass: "paved",
  };
}

function groundBatch(): PhysicsSyncBatch {
  const collider = groundCollider();
  return {
    originRevision: 1,
    created: [collider],
    updated: [],
    removed: [],
    activeColliders: 1,
    triangleCount: 2,
  };
}

describe("RapierPhysicsWorld", () => {
  let physics: RapierPhysicsWorld | undefined;

  afterEach(() => {
    physics?.dispose();
    physics = undefined;
  });

  it("supports a four-wheel raycast suspension on a static road trimesh", async () => {
    physics = new RapierPhysicsWorld();
    await physics.init();
    physics.sync(groundBatch());
    physics.spawnChassis({ x: 0, y: 1.35, z: 0 });

    for (let step = 0; step < 240; step += 1) physics.advance(1 / 60);
    const settled = physics.getChassisState();

    expect(settled.active).toBe(true);
    expect(settled.groundedWheels).toBeGreaterThanOrEqual(3);
    expect(settled.wheels).toHaveLength(4);
    expect(settled.wheels?.every((wheel) => wheel.suspensionLengthMeters > 0)).toBe(true);
    expect(settled.position?.y ?? 0).toBeGreaterThan(0.45);
    expect(settled.position?.y ?? 0).toBeLessThan(1.2);
  }, 20_000);

  it("drives the suspended chassis through wheel engine force", async () => {
    physics = new RapierPhysicsWorld();
    await physics.init();
    physics.sync(groundBatch());
    physics.spawnChassis({ x: 0, y: 1.35, z: 0 });

    for (let step = 0; step < 180; step += 1) physics.advance(1 / 60);
    const settled = physics.getChassisState();
    physics.setChassisControls({ throttle: 1, steer: 0, brake: 0 });
    for (let step = 0; step < 120; step += 1) physics.advance(1 / 60);
    const moving = physics.getChassisState();

    expect(moving.groundedWheels).toBeGreaterThanOrEqual(2);
    expect(Math.abs(moving.vehicleSpeedMetersPerSecond ?? 0)).toBeGreaterThan(0.25);
    expect(moving.position?.z ?? 0).toBeGreaterThan((settled.position?.z ?? 0) + 0.2);
    expect(moving.wheels?.filter((wheel) => wheel.drive).every((wheel) => wheel.engineForceN > 0)).toBe(true);
  }, 20_000);
});
