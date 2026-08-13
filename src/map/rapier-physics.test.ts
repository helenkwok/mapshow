import { afterEach, describe, expect, it } from "vitest";
import type { PhysicsSyncBatch, StaticTriMeshCollider } from "./physics-adapter";
import { RapierPhysicsWorld } from "./rapier-physics";

function groundCollider(): StaticTriMeshCollider {
  return {
    colliderId: "test-ground",
    kind: "road-segment",
    positions: [
      -20, 0, -20,
      20, 0, -20,
      20, 0, 20,
      -20, 0, 20,
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

  it("supports a falling and controlled chassis on a static road trimesh", async () => {
    physics = new RapierPhysicsWorld();
    await physics.init();
    physics.sync(groundBatch());
    physics.spawnChassis({ x: 0, y: 2, z: 0 });

    for (let step = 0; step < 180; step += 1) physics.advance(1 / 60);
    const settled = physics.getChassisState();

    expect(settled.active).toBe(true);
    expect(settled.position?.y).toBeLessThan(1);
    expect(settled.contactPairs).toBeGreaterThan(0);

    physics.setChassisControls({ throttle: 1, steer: 0, brake: 0 });
    for (let step = 0; step < 60; step += 1) physics.advance(1 / 60);
    const moving = physics.getChassisState();

    expect(moving.speedMetersPerSecond).toBeGreaterThan(0.25);
    expect(moving.position?.z ?? 0).toBeGreaterThan(settled.position?.z ?? 0);
  }, 20_000);
});
