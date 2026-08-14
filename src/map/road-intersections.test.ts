import { describe, expect, it } from "vitest";
import { isParametricJunctionNode } from "./road-intersections";
import type { RoadGraphNode, RoadWorld } from "./road-world";

function node(incidentSegmentIds: number[]): RoadGraphNode {
  return {
    nodeId: 100,
    position: [138.59867, -34.9163],
    incidentSegmentIds,
    outgoing: [],
    incoming: [],
  };
}

const emptyWorld: RoadWorld = {
  segments: [],
  nodes: new Map(),
  arcs: [],
};

describe("parametric road-node coverage", () => {
  it("covers degree-one endpoints so carrier strips have round caps", () => {
    expect(isParametricJunctionNode(node([1]), emptyWorld)).toBe(true);
  });

  it("covers degree-two joins additively", () => {
    expect(isParametricJunctionNode(node([1, 2]), emptyWorld)).toBe(true);
  });

  it("covers degree-three road junctions", () => {
    expect(isParametricJunctionNode(node([1, 2, 3]), emptyWorld)).toBe(true);
  });

  it("requires a resolved node position", () => {
    expect(
      isParametricJunctionNode(
        {
          nodeId: 100,
          incidentSegmentIds: [1, 2, 3],
          outgoing: [],
          incoming: [],
        },
        emptyWorld,
      ),
    ).toBe(false);
  });
});
