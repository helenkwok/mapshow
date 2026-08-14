import { MercatorCoordinate, type Map as MapLibreMap } from "maplibre-gl";
import { distanceMeters, type LngLatTuple } from "./building-feature";
import {
  junctionTrimDistanceM,
  type RoadCrossSection,
} from "./road-cross-section";
import { buildRoadProfilePart } from "./road-profile";
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

export function isParametricJunctionNode(node: RoadGraphNode, _world: RoadWorld): boolean {
  // A degree-two graph node has exactly one continuation through the node. Even when the two source
  // segments meet at a sharp bend or OSM way boundary, cutting both strips back and inserting a fan
  // creates an artificial junction and can leave lens-shaped holes. Let their full-width strips overlap
  // at the shared centerline node. A physical road junction needs at least three incident road segments.
  return node.position !== undefined && node.incidentSegmentIds.length >= 3;
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

function portalCenterElevation(boundary: Vertex2D[]): number {
  // The fill belongs to the same surface as its trimmed road portals. Sampling the node independently
  // can put a mixed bridge/ground junction centre on terrain while its portal edges remain on the deck,
  // producing a fan that dives through MapLibre terrain and appears as a white gap. A median keeps the
  // centre on the local road surface and is robust to one incident approach having a noisy DEM sample.
  const elevations = boundary
    .map((vertex) => vertex.z)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (elevations.length === 0) return 0;
  const middle = Math.floor(elevations.length / 2);
  return elevations.length % 2 === 0
    ? (elevations[middle - 1] + elevations[middle]) / 2
    : elevations[middle];
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
  if (incident.length < 3) return null;

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

  const centerZ = portalCenterElevation(boundary);
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
