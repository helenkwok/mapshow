import { describe, expect, it } from "vitest";
import type { GameRoadRecord } from "./game-roads";
import {
  deriveRoadCrossSection,
  junctionPortalDistanceM,
  junctionTrimDistanceM,
} from "./road-cross-section";
import type { SegmentLaneLayout } from "./road-lanes";
import type { RoadGraphNode, RoadWorldSegment } from "./road-world";

function record(overrides: Partial<GameRoadRecord> = {}): GameRoadRecord {
  return {
    schemaVersion: 3,
    segmentId: 1,
    osmId: 1,
    highway: "primary",
    roadClass: "primary",
    turnRestrictions: [],
    widthM: 13.6,
    widthSource: "lanes",
    surfaceClass: "paved",
    oneway: 0,
    bridge: false,
    tunnel: false,
    layer: 0,
    priority: 7,
    firstNode: 10,
    lastNode: 20,
    nodeCount: 3,
    lanes: 4,
    ...overrides,
  };
}

function layout(physicalLaneCount = 4): SegmentLaneLayout {
  return {
    segmentId: 1,
    physicalLaneCount,
    forwardLaneCount: Math.ceil(physicalLaneCount / 2),
    backwardLaneCount: Math.floor(physicalLaneCount / 2),
    laneWidthM: 3.4,
    lanes: [],
  };
}

function segment(r: GameRoadRecord): RoadWorldSegment {
  return {
    key: `road-segment:${r.segmentId}`,
    record: r,
    parts: [[[138.6, -34.9], [138.6001, -34.9]]],
    center: [138.60005, -34.9],
    distanceMeters: 0,
  };
}

describe("parametric road cross sections", () => {
  it("uses narrower urban lane parameters instead of the coarse generator estimate", () => {
    const section = deriveRoadCrossSection(record(), layout(4));
    expect(section.laneWidthM).toBeCloseTo(3.1, 4);
    expect(section.trafficWidthM).toBeCloseTo(12.4, 4);
    expect(section.roadWidthM).toBeCloseTo(12.9, 4);
    expect(section.laneBoundaryOffsetsM).toHaveLength(3);
    expect(section.laneBoundaryOffsetsM[0]).toBeCloseTo(3.1, 8);
    expect(section.laneBoundaryOffsetsM[1]).toBeCloseTo(0, 8);
    expect(section.laneBoundaryOffsetsM[2]).toBeCloseTo(-3.1, 8);
  });

  it("preserves authoritative tagged width while retaining bounded traffic lanes", () => {
    const section = deriveRoadCrossSection(
      record({ widthM: 15, widthSource: "tag" }),
      layout(4),
    );
    expect(section.roadWidthM).toBe(15);
    expect(section.laneWidthM).toBeLessThanOrEqual(3.7);
    expect(section.edgeMarginM).toBeGreaterThanOrEqual(0);
  });

  it("uses compact cross sections for service roads", () => {
    const section = deriveRoadCrossSection(
      record({ highway: "service", roadClass: "service", widthM: 4.5, lanes: 1 }),
      layout(1),
    );
    expect(section.roadWidthM).toBeCloseTo(3.02, 2);
    expect(section.laneWidthM).toBeCloseTo(2.7, 3);
  });

  it("keeps carrier strips continuous while bounding additive junction portals", () => {
    const arterial = record({ segmentId: 1, widthM: 20.4, lanes: 6 });
    const local = record({
      segmentId: 2,
      osmId: 2,
      highway: "residential",
      roadClass: "residential",
      widthM: 6,
      widthSource: "class_default",
      lanes: 2,
      priority: 4,
    });
    const sections = new Map([
      [1, deriveRoadCrossSection(arterial, layout(6))],
      [2, deriveRoadCrossSection(local, { ...layout(2), segmentId: 2 })],
    ]);
    const node: RoadGraphNode = {
      nodeId: 10,
      incidentSegmentIds: [1, 2, 3],
      outgoing: [],
      incoming: [],
      position: [138.6, -34.9],
    };
    const arterialSegment = segment(arterial);
    expect(junctionTrimDistanceM(arterialSegment, node, sections)).toBe(0);
    const portal = junctionPortalDistanceM(arterialSegment, node, sections);
    expect(portal).toBeGreaterThanOrEqual(2.4);
    expect(portal).toBeLessThanOrEqual(7.5);
  });
});
