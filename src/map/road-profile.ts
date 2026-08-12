import type { Map as MapLibreMap } from "maplibre-gl";
import { distanceMeters, type LngLatTuple } from "./building-feature";
import type { GameRoadRecord } from "./game-roads";
import type { RoadWorld, RoadWorldSegment } from "./road-world";

export interface RoadProfileSample {
  point: LngLatTuple;
  distanceM: number;
  elevationM: number;
}

export interface RoadProfilePart {
  samples: RoadProfileSample[];
  lengthM: number;
}

const MAX_SAMPLE_SPACING_METERS = 8;
const ROAD_SURFACE_LIFT_METERS = 0.08;
const BRIDGE_MIN_CLEARANCE_METERS = 4.5;
const TUNNEL_MIN_DEPTH_METERS = 3;
const VERTICAL_TRANSITION_MAX_METERS = 35;
const ENDPOINT_MATCH_TOLERANCE_METERS = 2.5;

function terrainElevation(map: MapLibreMap, point: LngLatTuple, enabled: boolean): number {
  if (!enabled) return 0;
  const elevation = map.queryTerrainElevation(point);
  return typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
}

function verticalOffset(record: GameRoadRecord): number {
  if (record.bridge) {
    return Math.max(BRIDGE_MIN_CLEARANCE_METERS, Math.max(1, record.layer) * 3.5);
  }
  if (record.tunnel) {
    return -Math.max(TUNNEL_MIN_DEPTH_METERS, Math.max(1, Math.abs(record.layer)) * 3);
  }
  return ROAD_SURFACE_LIFT_METERS;
}

function smoothstep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function connectedToDifferentVerticalMode(
  world: RoadWorld,
  segment: RoadWorldSegment,
  nodeId: number,
): boolean {
  const node = world.nodes.get(nodeId);
  if (!node) return false;
  const byId = new Map(world.segments.map((candidate) => [candidate.record.segmentId, candidate]));
  return node.incidentSegmentIds.some((segmentId) => {
    if (segmentId === segment.record.segmentId) return false;
    const other = byId.get(segmentId)?.record;
    if (!other) return false;
    return other.bridge !== segment.record.bridge || other.tunnel !== segment.record.tunnel;
  });
}

function endpointMatches(
  point: LngLatTuple,
  nodePosition: LngLatTuple | undefined,
): boolean {
  return nodePosition !== undefined && distanceMeters(point, nodePosition) <= ENDPOINT_MATCH_TOLERANCE_METERS;
}

export function densifyRoadLine(
  line: LngLatTuple[],
  maxSpacingMeters = MAX_SAMPLE_SPACING_METERS,
): Array<{ point: LngLatTuple; distanceM: number }> {
  if (line.length < 2) return line.map((point) => ({ point, distanceM: 0 }));
  const result: Array<{ point: LngLatTuple; distanceM: number }> = [
    { point: line[0], distanceM: 0 },
  ];
  let cumulative = 0;

  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1];
    const end = line[index];
    const length = distanceMeters(start, end);
    const steps = Math.max(1, Math.ceil(length / maxSpacingMeters));
    for (let step = 1; step <= steps; step += 1) {
      const previousT = (step - 1) / steps;
      const t = step / steps;
      const previous: LngLatTuple = [
        start[0] + (end[0] - start[0]) * previousT,
        start[1] + (end[1] - start[1]) * previousT,
      ];
      const point: LngLatTuple = [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ];
      cumulative += distanceMeters(previous, point);
      result.push({ point, distanceM: cumulative });
    }
  }
  return result;
}

function rollingSmooth(values: number[], passes: number, preserveEnds: boolean): number[] {
  let current = [...values];
  for (let pass = 0; pass < passes; pass += 1) {
    const next = [...current];
    for (let index = 1; index < current.length - 1; index += 1) {
      next[index] = current[index - 1] * 0.25 + current[index] * 0.5 + current[index + 1] * 0.25;
    }
    if (preserveEnds && current.length > 1) {
      next[0] = values[0];
      next[next.length - 1] = values[values.length - 1];
    }
    current = next;
  }
  return current;
}

function constrainGrade(
  values: number[],
  distances: number[],
  maxGrade: number,
  preserveEnds: boolean,
): number[] {
  if (values.length < 2) return values;
  const constrained = [...values];
  for (let index = 1; index < constrained.length; index += 1) {
    const deltaDistance = Math.max(0.1, distances[index] - distances[index - 1]);
    const maxDelta = deltaDistance * maxGrade;
    constrained[index] = Math.max(
      constrained[index - 1] - maxDelta,
      Math.min(constrained[index - 1] + maxDelta, constrained[index]),
    );
  }
  for (let index = constrained.length - 2; index >= 0; index -= 1) {
    const deltaDistance = Math.max(0.1, distances[index + 1] - distances[index]);
    const maxDelta = deltaDistance * maxGrade;
    constrained[index] = Math.max(
      constrained[index + 1] - maxDelta,
      Math.min(constrained[index + 1] + maxDelta, constrained[index]),
    );
  }
  if (preserveEnds) {
    constrained[0] = values[0];
    constrained[constrained.length - 1] = values[values.length - 1];
  }
  return constrained;
}

function profileSettings(record: GameRoadRecord): { passes: number; maxGrade: number } {
  if (record.bridge) return { passes: 3, maxGrade: 0.08 };
  if (record.tunnel) return { passes: 3, maxGrade: 0.1 };
  if (["motorway", "trunk", "primary", "secondary"].includes(record.roadClass)) {
    return { passes: 2, maxGrade: 0.12 };
  }
  if (record.roadClass === "track") return { passes: 1, maxGrade: 0.3 };
  return { passes: 1, maxGrade: 0.2 };
}

export function buildRoadProfilePart(
  map: MapLibreMap,
  world: RoadWorld,
  segment: RoadWorldSegment,
  line: LngLatTuple[],
  terrainEnabled: boolean,
): RoadProfilePart {
  const dense = densifyRoadLine(line);
  if (dense.length === 0) return { samples: [], lengthM: 0 };
  const lengthM = dense[dense.length - 1].distanceM;
  const firstNode = world.nodes.get(segment.record.firstNode);
  const lastNode = world.nodes.get(segment.record.lastNode);
  const startTransitions =
    (segment.record.bridge || segment.record.tunnel) &&
    connectedToDifferentVerticalMode(world, segment, segment.record.firstNode) &&
    endpointMatches(dense[0].point, firstNode?.position);
  const endTransitions =
    (segment.record.bridge || segment.record.tunnel) &&
    connectedToDifferentVerticalMode(world, segment, segment.record.lastNode) &&
    endpointMatches(dense[dense.length - 1].point, lastNode?.position);
  const transitionLength = Math.min(
    VERTICAL_TRANSITION_MAX_METERS,
    Math.max(8, lengthM * 0.3),
  );
  const targetOffset = verticalOffset(segment.record);

  const raw = dense.map(({ point, distanceM }) => {
    const ground = terrainElevation(map, point, terrainEnabled);
    if (!segment.record.bridge && !segment.record.tunnel) {
      return ground + ROAD_SURFACE_LIFT_METERS;
    }
    const startFactor = startTransitions
      ? smoothstep01(distanceM / transitionLength)
      : 1;
    const endFactor = endTransitions
      ? smoothstep01((lengthM - distanceM) / transitionLength)
      : 1;
    return ground + targetOffset * Math.min(startFactor, endFactor);
  });

  const settings = profileSettings(segment.record);
  const preserveEnds = startTransitions || endTransitions || (!segment.record.bridge && !segment.record.tunnel);
  const smoothed = rollingSmooth(raw, settings.passes, preserveEnds);
  const constrained = constrainGrade(
    smoothed,
    dense.map((sample) => sample.distanceM),
    settings.maxGrade,
    preserveEnds,
  );

  return {
    lengthM,
    samples: dense.map((sample, index) => ({
      ...sample,
      elevationM: constrained[index],
    })),
  };
}

export function roadNodeElevation(
  map: MapLibreMap,
  world: RoadWorld,
  nodeId: number,
  terrainEnabled: boolean,
): number {
  const node = world.nodes.get(nodeId);
  if (!node?.position) return 0;
  const incident = node.incidentSegmentIds
    .map((id) => world.segments.find((segment) => segment.record.segmentId === id))
    .filter((segment): segment is RoadWorldSegment => segment !== undefined);
  if (incident.length === 0) return terrainElevation(map, node.position, terrainEnabled) + ROAD_SURFACE_LIFT_METERS;

  // At mixed ground/bridge/tunnel endpoints, keep the junction on terrain and let the vertical structure transition
  // after the node. Homogeneous elevated junctions retain their vertical offset.
  const hasGround = incident.some((segment) => !segment.record.bridge && !segment.record.tunnel);
  if (hasGround) return terrainElevation(map, node.position, terrainEnabled) + ROAD_SURFACE_LIFT_METERS;
  const dominant = [...incident].sort((a, b) => b.record.priority - a.record.priority)[0];
  return terrainElevation(map, node.position, terrainEnabled) + verticalOffset(dominant.record);
}
