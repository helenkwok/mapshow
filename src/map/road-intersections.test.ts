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

describe("parametric road junction classification", () => {
  it("keeps degree-two source-way joins continuous", () => {
    expect(isParametricJunctionNode(node([1, 2]), emptyWorld)).toBe(false);
  });

  it("treats degree-three road nodes as physical junctions", () => {
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
