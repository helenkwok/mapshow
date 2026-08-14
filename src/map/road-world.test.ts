import { describe, expect, it } from "vitest";
import { stitchRoadFragments } from "./road-world";

// Around Adelaide, 0.00001 degrees of longitude is just under one metre.
const BASE_LAT = -34.9163;

describe("road MVT fragment stitching", () => {
  it("snaps small same-segment gaps introduced by tile clipping and quantization", () => {
    const parts = stitchRoadFragments([
      [[138.5980, BASE_LAT], [138.5985, BASE_LAT]],
      [[138.59853, BASE_LAT], [138.5990, BASE_LAT]],
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0][0]).toEqual([138.5980, BASE_LAT]);
    expect(parts[0][parts[0].length - 1]).toEqual([138.5990, BASE_LAT]);
  });

  it("does not bridge clearly separate fragments", () => {
    const parts = stitchRoadFragments([
      [[138.5980, BASE_LAT], [138.5985, BASE_LAT]],
      [[138.5987, BASE_LAT], [138.5990, BASE_LAT]],
    ]);
    expect(parts).toHaveLength(2);
  });
});
