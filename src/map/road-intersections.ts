import { MercatorCoordinate, type Map as MapLibreMap } from "maplibre-gl";
import { distanceMeters, type LngLatTuple } from "./building-feature";
import { buildRoadProfilePart, roadNodeElevation } from "./road-profile";
import type { RoadGraphNode, RoadWorld, RoadWorldSegment } from "./road-world";

interface Vertex2D {
  x: number;
  y: number;
  z: number;
}

export interface PreparedIntersection {
  nodeId: number;
  origin: MercatorCoordinate;
  meterScale: number;
  positions: number[];
  indices: number[];
  dominantSegment: RoadWorldSegment;
}

const MIN_APPROACH_DISTANCE_METERS = 3;
const MAX_APPROACH_DISTANCE_METERS = 10;

function primaryPart(segment: RoadWorldSegment): LngLatTuple[] | undefined {
  return [...segment.parts].sort((a, b) => b.length - a.length)[0];
}

function interpolateAlongFromEndpoint(
  line: LngLatTuple[],
  nodePosition: LngLatTuple,
  targetDistanceM: number,
): LngLatTuple | undefined {
  if (line.length < 2) return undefined;
  const fromStart = distanceMeters(nodePosition, line[0]) <= distanceMeters(nodePosition, line[line.length - 1]);
  const ordered = fromStart ? line : [...line].reverse();
  let travelled = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const start = ordered[index - 1];
    const end = ordered[index];
    const segmentLength = distanceMeters(start, end);
    if (travelled + segmentLength >= targetDistanceM) {
      const t = segmentLength > 0 ? (targetDistanceM - travelled) / segmentLength : 0;
      return [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ];
    }
    travelled += segmentLength;
  }
  return ordered[ordered.length - 1];
}

function nearestProfileElevation(
  segment: RoadWorldSegment,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
  point: LngLatTuple,
): number {
  const part = primaryPart(segment);
  if (!part) return 0;
  const profile = buildRoadProfilePart(map, world, segment, part, terrainEnabled);
  let nearestDistance = Number.POSITIVE_INFINITY;
  let elevation = 0;
  for (const sample of profile.samples) {
    const distance = distanceMeters(sample.point, point);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      elevation = sample.elevationM;
    }
  }
  return elevation;
}

function cross(origin: Vertex2D, a: Vertex2D, b: Vertex2D): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: Vertex2D[]): Vertex2D[] {
  if (points.length <= 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Vertex2D[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vertex2D[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function approachBoundaryVertices(
  nodePosition: LngLatTuple,
  segment: RoadWorldSegment,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
  origin: MercatorCoordinate,
  meterScale: number,
): Vertex2D[] {
  const line = primaryPart(segment);
  if (!line) return [];
  const approachDistance = Math.max(
    MIN_APPROACH_DISTANCE_METERS,
    Math.min(MAX_APPROACH_DISTANCE_METERS, segment.record.widthM * 0.9),
  );
  const approach = interpolateAlongFromEndpoint(line, nodePosition, approachDistance);
  if (!approach) return [];
  const mercator = MercatorCoordinate.fromLngLat(approach, 0);
  let x = (mercator.x - origin.x) / meterScale;
  let y = (mercator.y - origin.y) / meterScale;
  const length = Math.hypot(x, y);
  if (length < 0.2) return [];
  x /= length;
  y /= length;
  const centerX = x * Math.min(length, approachDistance);
  const centerY = y * Math.min(length, approachDistance);
  const normalX = -y;
  const normalY = x;
  const halfWidth = Math.max(1.4, segment.record.widthM / 2) + 0.12;
  const elevation = nearestProfileElevation(segment, world, map, terrainEnabled, approach);
  return [
    {
      x: centerX + normalX * halfWidth,
      y: centerY + normalY * halfWidth,
      z: elevation,
    },
    {
      x: centerX - normalX * halfWidth,
      y: centerY - normalY * halfWidth,
      z: elevation,
    },
  ];
}

export function prepareIntersectionPolygon(
  node: RoadGraphNode,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
): PreparedIntersection | null {
  if (!node.position || node.incidentSegmentIds.length < 2) return null;
  const byId = new Map(world.segments.map((segment) => [segment.record.segmentId, segment]));
  const incident = node.incidentSegmentIds
    .map((id) => byId.get(id))
    .filter((segment): segment is RoadWorldSegment => segment !== undefined);
  if (incident.length < 2) return null;

  const dominantSegment = [...incident].sort((a, b) => b.record.priority - a.record.priority)[0];
  const origin = MercatorCoordinate.fromLngLat(node.position, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const boundary = incident.flatMap((segment) =>
    approachBoundaryVertices(node.position!, segment, world, map, terrainEnabled, origin, meterScale),
  );
  const hull = convexHull(boundary);
  if (hull.length < 3) return null;

  const centerZ = roadNodeElevation(map, world, node.nodeId, terrainEnabled);
  const positions: number[] = [0, 0, centerZ];
  const indices: number[] = [];
  for (const vertex of hull) positions.push(vertex.x, vertex.y, vertex.z);
  for (let index = 0; index < hull.length; index += 1) {
    const next = (index + 1) % hull.length;
    indices.push(0, index + 1, next + 1);
  }

  return {
    nodeId: node.nodeId,
    origin,
    meterScale,
    positions,
    indices,
    dominantSegment,
  };
}
