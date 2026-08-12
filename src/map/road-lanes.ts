import { distanceMeters, type LngLatTuple } from "./building-feature";
import type { GameRoadRecord } from "./game-roads";
import type { RoadWorld, RoadWorldSegment } from "./road-world";

export type DrivingSide = "left" | "right";
export type LaneDirection = "forward" | "backward";
export type TurnKind = "straight" | "left" | "right" | "uturn";

export interface RoadLane {
  laneId: string;
  segmentId: number;
  osmId: number;
  direction: LaneDirection;
  ordinal: number;
  laneCountInDirection: number;
  lateralOffsetM: number;
  laneWidthM: number;
  fromNode: number;
  toNode: number;
  speedKmh?: number;
}

export interface SegmentLaneLayout {
  segmentId: number;
  physicalLaneCount: number;
  forwardLaneCount: number;
  backwardLaneCount: number;
  laneWidthM: number;
  lanes: RoadLane[];
}

export interface RoadLaneConnection {
  nodeId: number;
  fromLaneId: string;
  toLaneId: string;
  fromSegmentId: number;
  toSegmentId: number;
  turn: TurnKind;
}

export interface RoadLaneNetwork {
  layouts: Map<number, SegmentLaneLayout>;
  lanes: Map<string, RoadLane>;
  connections: RoadLaneConnection[];
}

const NOMINAL_LANE_WIDTH_METERS = 3.2;
const MAX_INFERRED_LANES = 8;

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function inferredPhysicalLaneCount(record: GameRoadRecord): number {
  const tagged = positiveInteger(record.lanes);
  if (tagged !== undefined) return Math.min(MAX_INFERRED_LANES, tagged);
  return Math.max(
    1,
    Math.min(MAX_INFERRED_LANES, Math.round(record.widthM / NOMINAL_LANE_WIDTH_METERS)),
  );
}

function directionalCounts(record: GameRoadRecord, physicalLaneCount: number): {
  forward: number;
  backward: number;
} {
  if (record.oneway === 1) return { forward: physicalLaneCount, backward: 0 };
  if (record.oneway === -1) return { forward: 0, backward: physicalLaneCount };

  if (physicalLaneCount === 1) {
    // A one-lane two-way road is represented by two directed logical lanes sharing one physical center path.
    return { forward: 1, backward: 1 };
  }

  let forward = positiveInteger(record.lanesForward);
  let backward = positiveInteger(record.lanesBackward);

  if (forward !== undefined && backward !== undefined) {
    return { forward, backward };
  }
  if (forward !== undefined) {
    return { forward, backward: Math.max(1, physicalLaneCount - forward) };
  }
  if (backward !== undefined) {
    return { forward: Math.max(1, physicalLaneCount - backward), backward };
  }

  // When only total lanes are known, keep the split deterministic. Odd extra lanes follow source-way direction.
  forward = Math.ceil(physicalLaneCount / 2);
  backward = Math.floor(physicalLaneCount / 2);
  return { forward, backward: Math.max(1, backward) };
}

function physicalSlotOffsets(widthM: number, count: number): number[] {
  if (count <= 1) return [0];
  const laneWidth = widthM / count;
  return Array.from({ length: count }, (_, index) => widthM / 2 - laneWidth * (index + 0.5));
}

function slotsForDirection(
  offsetsLeftToRight: number[],
  count: number,
  direction: LaneDirection,
  drivingSide: DrivingSide,
): number[] {
  if (count <= 0) return [];
  const forwardUsesLeft = drivingSide === "left";
  const usesLeft = direction === "forward" ? forwardUsesLeft : !forwardUsesLeft;
  const ordered = usesLeft ? offsetsLeftToRight : [...offsetsLeftToRight].reverse();
  return ordered.slice(0, count).sort((a, b) => {
    // Ordinal zero stays nearest the centerline within each direction where possible.
    const abs = Math.abs(a) - Math.abs(b);
    return abs === 0 ? a - b : abs;
  });
}

export function deriveLaneLayout(
  record: GameRoadRecord,
  drivingSide: DrivingSide,
): SegmentLaneLayout {
  const physicalLaneCount = inferredPhysicalLaneCount(record);
  const counts = directionalCounts(record, physicalLaneCount);
  const actualPhysicalCount = record.oneway === 0 && physicalLaneCount === 1
    ? 1
    : Math.max(physicalLaneCount, counts.forward + counts.backward);
  const laneWidthM = record.widthM / actualPhysicalCount;
  const slots = physicalSlotOffsets(record.widthM, actualPhysicalCount);

  const forwardOffsets = record.oneway === 0 && physicalLaneCount === 1
    ? [0]
    : slotsForDirection(slots, counts.forward, "forward", drivingSide);
  const backwardOffsets = record.oneway === 0 && physicalLaneCount === 1
    ? [0]
    : slotsForDirection(
        slots.filter((slot) => !forwardOffsets.includes(slot)),
        counts.backward,
        "backward",
        drivingSide,
      );

  const lanes: RoadLane[] = [];
  for (let ordinal = 0; ordinal < counts.forward; ordinal += 1) {
    lanes.push({
      laneId: `${record.segmentId}:f:${ordinal}`,
      segmentId: record.segmentId,
      osmId: record.osmId,
      direction: "forward",
      ordinal,
      laneCountInDirection: counts.forward,
      lateralOffsetM: forwardOffsets[ordinal] ?? 0,
      laneWidthM,
      fromNode: record.firstNode,
      toNode: record.lastNode,
      speedKmh: record.speedForwardKmh ?? record.speedKmh,
    });
  }
  for (let ordinal = 0; ordinal < counts.backward; ordinal += 1) {
    lanes.push({
      laneId: `${record.segmentId}:b:${ordinal}`,
      segmentId: record.segmentId,
      osmId: record.osmId,
      direction: "backward",
      ordinal,
      laneCountInDirection: counts.backward,
      lateralOffsetM: backwardOffsets[ordinal] ?? 0,
      laneWidthM,
      fromNode: record.lastNode,
      toNode: record.firstNode,
      speedKmh: record.speedBackwardKmh ?? record.speedKmh,
    });
  }

  return {
    segmentId: record.segmentId,
    physicalLaneCount: actualPhysicalCount,
    forwardLaneCount: counts.forward,
    backwardLaneCount: counts.backward,
    laneWidthM,
    lanes,
  };
}

function primaryPart(segment: RoadWorldSegment): LngLatTuple[] | undefined {
  return [...segment.parts].sort((a, b) => b.length - a.length)[0];
}

function endpointVectorAwayFromNode(
  segment: RoadWorldSegment,
  nodePosition: LngLatTuple,
): { x: number; y: number } | undefined {
  const part = primaryPart(segment);
  if (!part || part.length < 2) return undefined;
  const startDistance = distanceMeters(nodePosition, part[0]);
  const endDistance = distanceMeters(nodePosition, part[part.length - 1]);
  const node = startDistance <= endDistance ? part[0] : part[part.length - 1];
  const next = startDistance <= endDistance ? part[1] : part[part.length - 2];
  const latitudeRadians = (nodePosition[1] * Math.PI) / 180;
  const x = (next[0] - node[0]) * Math.cos(latitudeRadians);
  const y = next[1] - node[1];
  const length = Math.hypot(x, y);
  if (length < 1e-12) return undefined;
  return { x: x / length, y: y / length };
}

function classifyTurn(
  incomingSegment: RoadWorldSegment,
  outgoingSegment: RoadWorldSegment,
  nodePosition: LngLatTuple,
): TurnKind {
  const incomingAway = endpointVectorAwayFromNode(incomingSegment, nodePosition);
  const outgoingAway = endpointVectorAwayFromNode(outgoingSegment, nodePosition);
  if (!incomingAway || !outgoingAway) return "straight";

  // Vehicle direction entering the node is opposite the vector pointing away from it.
  const inX = -incomingAway.x;
  const inY = -incomingAway.y;
  const outX = outgoingAway.x;
  const outY = outgoingAway.y;
  const dot = Math.max(-1, Math.min(1, inX * outX + inY * outY));
  const cross = inX * outY - inY * outX;
  const angle = Math.atan2(cross, dot) * 180 / Math.PI;
  const absolute = Math.abs(angle);
  if (absolute < 35) return "straight";
  if (absolute > 150) return "uturn";
  return angle > 0 ? "left" : "right";
}

function closestOrdinalLane(fromLane: RoadLane, candidates: RoadLane[]): RoadLane | undefined {
  if (candidates.length === 0) return undefined;
  const fromRank = fromLane.laneCountInDirection <= 1
    ? 0
    : fromLane.ordinal / (fromLane.laneCountInDirection - 1);
  return [...candidates].sort((a, b) => {
    const aRank = a.laneCountInDirection <= 1 ? 0 : a.ordinal / (a.laneCountInDirection - 1);
    const bRank = b.laneCountInDirection <= 1 ? 0 : b.ordinal / (b.laneCountInDirection - 1);
    return Math.abs(aRank - fromRank) - Math.abs(bRank - fromRank);
  })[0];
}

export function buildLaneNetwork(world: RoadWorld, drivingSide: DrivingSide): RoadLaneNetwork {
  const layouts = new Map<number, SegmentLaneLayout>();
  const lanes = new Map<string, RoadLane>();
  const bySegment = new Map(world.segments.map((segment) => [segment.record.segmentId, segment]));

  for (const segment of world.segments) {
    const layout = deriveLaneLayout(segment.record, drivingSide);
    layouts.set(segment.record.segmentId, layout);
    for (const lane of layout.lanes) lanes.set(lane.laneId, lane);
  }

  const incomingByNode = new Map<number, RoadLane[]>();
  const outgoingByNode = new Map<number, RoadLane[]>();
  for (const lane of lanes.values()) {
    const incoming = incomingByNode.get(lane.toNode) ?? [];
    incoming.push(lane);
    incomingByNode.set(lane.toNode, incoming);
    const outgoing = outgoingByNode.get(lane.fromNode) ?? [];
    outgoing.push(lane);
    outgoingByNode.set(lane.fromNode, outgoing);
  }

  const connections: RoadLaneConnection[] = [];
  for (const [nodeId, incoming] of incomingByNode) {
    const node = world.nodes.get(nodeId);
    const outgoing = outgoingByNode.get(nodeId) ?? [];
    if (!node?.position || incoming.length === 0 || outgoing.length === 0) continue;

    const outgoingBySegment = new Map<number, RoadLane[]>();
    for (const lane of outgoing) {
      const bucket = outgoingBySegment.get(lane.segmentId) ?? [];
      bucket.push(lane);
      outgoingBySegment.set(lane.segmentId, bucket);
    }

    for (const fromLane of incoming) {
      const fromSegment = bySegment.get(fromLane.segmentId);
      if (!fromSegment) continue;
      for (const [toSegmentId, candidates] of outgoingBySegment) {
        if (fromLane.segmentId === toSegmentId) continue; // no implicit U-turns in the candidate lane graph
        const toSegment = bySegment.get(toSegmentId);
        if (!toSegment) continue;
        const turn = classifyTurn(fromSegment, toSegment, node.position);
        if (turn === "uturn") continue;
        const toLane = closestOrdinalLane(fromLane, candidates);
        if (!toLane) continue;
        connections.push({
          nodeId,
          fromLaneId: fromLane.laneId,
          toLaneId: toLane.laneId,
          fromSegmentId: fromLane.segmentId,
          toSegmentId: toLane.segmentId,
          turn,
        });
      }
    }
  }

  return { layouts, lanes, connections };
}
