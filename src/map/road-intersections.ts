import { MercatorCoordinate, type Map as MapLibreMap } from "maplibre-gl";
import { distanceMeters, type LngLatTuple } from "./building-feature";
import {
  junctionTrimDistanceM,
  type RoadCrossSection,
} from "./road-cross-section";
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

function primaryPart(segment: RoadWorldSegment): LngLatTuple[] | undefined {
  return [...segment.parts].sort((a, b) => b.length - a.length)[0];
}

function unitVectorAwayFromNode(
  segment: RoadWorldSegment,
  nodePosition: LngLatTuple,
): { x: number; y: number } | undefined {
  const line = primaryPart(segment);
  if (!line || line.length < 2) return undefined;
  const fromStart = distanceMeters(nodePosition, line[0]) <= distanceMeters(nodePosition, line[line.length - 1]);
  const node = fromStart ? line[0] : line[line.length - 1];
  const next = fromStart ? line[1] : line[line.length - 2];
  const latitudeRadians = (nodePosition[1] * Math.PI) / 180;
  const x = (next[0] - node[0]) * Math.cos(latitudeRadians);
  const y = next[1] - node[1];
  const length = Math.hypot(x, y);
  return length > 1e-12 ? { x: x / length, y: y / length } : undefined;
}

export function isParametricJunctionNode(node: RoadGraphNode, world: RoadWorld): boolean {
  if (!node.position || node.incidentSegmentIds.length < 2) return false;
  if (node.incidentSegmentIds.length > 2) return true;

  const byId = new Map(world.segments.map((segment) => [segment.record.segmentId, segment]));
  const incident = node.incidentSegmentIds
    .map((id) => byId.get(id))
    .filter((segment): segment is RoadWorldSegment => segment !== undefined);
  if (incident.length !== 2) return false;

  const a = unitVectorAwayFromNode(incident[0], node.position);
  const b = unitVectorAwayFromNode(incident[1], node.position);
  if (!a || !b) return false;
  const dot = a.x * b.x + a.y * b.y;
  // Two approaches pointing in nearly opposite directions form one continuous carriageway rather than a junction.
  return dot > -0.94;
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

function approachBoundaryVertices(
  node: RoadGraphNode,
  segment: RoadWorldSegment,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
  origin: MercatorCoordinate,
  meterScale: number,
  crossSections: Map<number, RoadCrossSection>,
): Vertex2D[] {
  if (!node.position) return [];
  const line = primaryPart(segment);
  const section = crossSections.get(segment.record.segmentId);
  if (!line || !section) return [];

  const approachDistance = junctionTrimDistanceM(segment, node, crossSections);
  const approach = interpolateAlongFromEndpoint(line, node.position, approachDistance);
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
  const halfWidth = section.halfWidthM + 0.06;
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

function orderedBoundary(points: Vertex2D[]): Vertex2D[] {
  const ordered = [...points].sort(
    (a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x),
  );
  const result: Vertex2D[] = [];
  for (const point of ordered) {
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.18) {
      result.push(point);
    }
  }
  if (
    result.length > 2
    && Math.hypot(result[0].x - result[result.length - 1].x, result[0].y - result[result.length - 1].y) <= 0.18
  ) {
    result.pop();
  }
  return result;
}

export function prepareIntersectionPolygon(
  node: RoadGraphNode,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
  crossSections: Map<number, RoadCrossSection>,
): PreparedIntersection | null {
  if (!isParametricJunctionNode(node, world) || !node.position) return null;
  const byId = new Map(world.segments.map((segment) => [segment.record.segmentId, segment]));
  const incident = node.incidentSegmentIds
    .map((id) => byId.get(id))
    .filter((segment): segment is RoadWorldSegment => segment !== undefined);
  if (incident.length < 2) return null;

  const dominantSegment = [...incident].sort((a, b) => b.record.priority - a.record.priority)[0];
  const origin = MercatorCoordinate.fromLngLat(node.position, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const boundary = orderedBoundary(
    incident.flatMap((segment) =>
      approachBoundaryVertices(
        node,
        segment,
        world,
        map,
        terrainEnabled,
        origin,
        meterScale,
        crossSections,
      ),
    ),
  );
  if (boundary.length < 3) return null;

  const centerZ = roadNodeElevation(map, world, node.nodeId, terrainEnabled);
  const positions: number[] = [0, 0, centerZ];
  const indices: number[] = [];
  for (const vertex of boundary) positions.push(vertex.x, vertex.y, vertex.z);
  for (let index = 0; index < boundary.length; index += 1) {
    const next = (index + 1) % boundary.length;
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
