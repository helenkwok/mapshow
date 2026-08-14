import type { GameRoadRecord } from "./game-roads";
import type { SegmentLaneLayout } from "./road-lanes";
import type { RoadGraphNode, RoadWorld, RoadWorldSegment } from "./road-world";

export interface RoadCrossSection {
  roadWidthM: number;
  halfWidthM: number;
  trafficWidthM: number;
  laneWidthM: number;
  edgeMarginM: number;
  laneBoundaryOffsetsM: number[];
  edgeOffsetsM: [number, number];
}

const MIN_LANE_WIDTH_M = 2.6;
const MAX_LANE_WIDTH_M = 3.7;
const MIN_ROAD_WIDTH_M = 2.8;
const MIN_JUNCTION_TRIM_M = 2.4;
const MAX_JUNCTION_TRIM_M = 7.5;

function targetLaneWidthM(record: GameRoadRecord): number {
  if (record.highway.endsWith("_link")) return 2.9;
  switch (record.roadClass) {
    case "motorway":
      return 3.5;
    case "trunk":
      return 3.3;
    case "primary":
      return 3.1;
    case "secondary":
      return 3.0;
    case "tertiary":
      return 2.95;
    case "unclassified":
    case "residential":
      return 2.85;
    case "living_street":
    case "service":
      return 2.7;
    case "track":
      return 2.8;
    case "busway":
      return 3.2;
    case "raceway":
      return 4.0;
    default:
      return 3.0;
  }
}

function targetEdgeMarginM(record: GameRoadRecord): number {
  if (record.highway.endsWith("_link")) return 0.14;
  switch (record.roadClass) {
    case "motorway":
    case "trunk":
      return 0.35;
    case "primary":
    case "secondary":
      return 0.25;
    case "tertiary":
      return 0.2;
    default:
      return 0.16;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveRoadCrossSection(
  record: GameRoadRecord,
  layout: SegmentLaneLayout,
): RoadCrossSection {
  const laneCount = Math.max(1, layout.physicalLaneCount);
  const preferredLaneWidth = targetLaneWidthM(record);
  let edgeMarginM = targetEdgeMarginM(record);
  let roadWidthM: number;
  let trafficWidthM: number;

  if (record.widthSource === "tag") {
    roadWidthM = Math.max(MIN_ROAD_WIDTH_M, record.widthM);
    const availableTrafficWidth = Math.max(MIN_LANE_WIDTH_M * laneCount, roadWidthM - edgeMarginM * 2);
    const laneWidth = clamp(availableTrafficWidth / laneCount, MIN_LANE_WIDTH_M, MAX_LANE_WIDTH_M);
    trafficWidthM = Math.min(roadWidthM, laneWidth * laneCount);
    edgeMarginM = Math.max(0, (roadWidthM - trafficWidthM) / 2);
  } else {
    const laneWidth = clamp(preferredLaneWidth, MIN_LANE_WIDTH_M, MAX_LANE_WIDTH_M);
    trafficWidthM = laneWidth * laneCount;
    roadWidthM = Math.max(MIN_ROAD_WIDTH_M, trafficWidthM + edgeMarginM * 2);
  }

  const laneWidthM = trafficWidthM / laneCount;
  const laneBoundaryOffsetsM = Array.from(
    { length: Math.max(0, laneCount - 1) },
    (_, index) => trafficWidthM / 2 - laneWidthM * (index + 1),
  );

  return {
    roadWidthM,
    halfWidthM: roadWidthM / 2,
    trafficWidthM,
    laneWidthM,
    edgeMarginM,
    laneBoundaryOffsetsM,
    edgeOffsetsM: [-trafficWidthM / 2, trafficWidthM / 2],
  };
}

export function crossSectionsForWorld(
  world: RoadWorld,
  layouts: Map<number, SegmentLaneLayout>,
): Map<number, RoadCrossSection> {
  const result = new Map<number, RoadCrossSection>();
  for (const segment of world.segments) {
    const layout = layouts.get(segment.record.segmentId);
    if (!layout) continue;
    result.set(segment.record.segmentId, deriveRoadCrossSection(segment.record, layout));
  }
  return result;
}

export function junctionTrimDistanceM(
  segment: RoadWorldSegment,
  node: RoadGraphNode,
  crossSections: Map<number, RoadCrossSection>,
): number {
  const own = crossSections.get(segment.record.segmentId);
  const ownHalfWidth = own?.halfWidthM ?? Math.max(1.4, segment.record.widthM / 2);
  let maxIncidentHalfWidth = ownHalfWidth;
  for (const segmentId of node.incidentSegmentIds) {
    maxIncidentHalfWidth = Math.max(
      maxIncidentHalfWidth,
      crossSections.get(segmentId)?.halfWidthM ?? 0,
    );
  }
  const complexity = Math.max(0, node.incidentSegmentIds.length - 2) * 0.22;
  return clamp(
    Math.max(ownHalfWidth * 0.62, maxIncidentHalfWidth * 0.52) + 0.75 + complexity,
    MIN_JUNCTION_TRIM_M,
    MAX_JUNCTION_TRIM_M,
  );
}
