import { describe, expect, it } from "vitest";
import { buildCollisionStrip, collisionWorldFromBodies, simplifyCollisionPoints } from "./road-collision";

describe("road collision geometry", () => {
  it("simplifies dense centerline samples while preserving endpoints", () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 8, y: 0, z: 0 },
      { x: 12, y: 0, z: 0 },
      { x: 18, y: 0, z: 0 },
      { x: 24, y: 0, z: 0 },
    ];

    expect(simplifyCollisionPoints(points, 10)).toEqual([
      points[0],
      points[3],
      points[5],
    ]);
  });

  it("builds a two-triangle strip for one straight road span", () => {
    const strip = buildCollisionStrip(
      [
        { x: 0, y: 0, z: 3 },
        { x: 10, y: 0, z: 3 },
      ],
      2,
    );

    expect(strip.positions).toEqual([
      0, 2, 3,
      0, -2, 3,
      10, 2, 3,
      10, -2, 3,
    ]);
    expect(strip.indices).toEqual([0, 1, 2, 1, 3, 2]);
  });

  it("counts triangles across collision bodies", () => {
    const world = collisionWorldFromBodies([
      {
        bodyId: "road:1",
        kind: "road-segment",
        origin: {} as never,
        meterScale: 1,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
      {
        bodyId: "junction:2",
        kind: "intersection",
        origin: {} as never,
        meterScale: 1,
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        indices: [0, 1, 2, 0, 2, 3],
      },
    ]);

    expect(world.bodies).toHaveLength(2);
    expect(world.triangleCount).toBe(3);
  });
});
