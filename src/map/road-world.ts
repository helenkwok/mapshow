import { distanceMeters, type LngLatTuple } from "./building-feature";
import {
  gameRoadFromFeature,
  type GameRoadFeature,
  type GameRoadRecord,
} from "./game-roads";

export interface RoadWorldSegment {
  key: string;
  record: GameRoadRecord;
  parts: LngLatTuple[][];
  center: LngLatTuple;
  distanceMeters: number;
}

export interface RoadGraphArc {
  segmentId: number;
  fromNode: number;
  toNode: number;
}

export interface RoadGraphNode {
  nodeId: number;
  position?: LngLatTuple;
  incidentSegmentIds: number[];
  outgoing: RoadGraphArc[];
  incoming: RoadGraphArc[];
}

export interface RoadWorld {
  segments: RoadWorldSegment[];
  nodes: Map<number, RoadGraphNode>;
  arcs: RoadGraphArc[];
}

interface SegmentAccumulator {
  record: GameRoadRecord;
  fragments: LngLatTuple[][];
}

const STITCH_TOLERANCE_METERS = 0.9;

function isLngLat(value: unknown): value is LngLatTuple {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function asLine(value: unknown): LngLatTuple[] | null {
  if (!Array.isArray(value)) return null;
  const points = value.filter(isLngLat);
  return points.length >= 2 ? removeConsecutiveDuplicates(points) : null;
}

function lineParts(feature: GameRoadFeature): LngLatTuple[][] {
  const geometry = feature.geometry as { type: string; coordinates?: unknown };
  if (geometry.type === "LineString") {
    const line = asLine(geometry.coordinates);
    return line ? [line] : [];
  }
  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates
      .map(asLine)
      .filter((line): line is LngLatTuple[] => line !== null);
  }
  return [];
}

function removeConsecutiveDuplicates(line: LngLatTuple[]): LngLatTuple[] {
  const result: LngLatTuple[] = [];
  for (const point of line) {
    const previous = result[result.length - 1];
    if (!previous || distanceMeters(previous, point) > 0.02) result.push(point);
  }
  return result;
}

function pointNear(a: LngLatTuple, b: LngLatTuple): boolean {
  return distanceMeters(a, b) <= STITCH_TOLERANCE_METERS;
}

function fingerprint(line: LngLatTuple[]): string {
  return line.map(([lng, lat]) => `${lng.toFixed(7)},${lat.toFixed(7)}`).join(";");
}

function overlapCount(a: LngLatTuple[], b: LngLatTuple[]): number {
  const limit = Math.min(a.length, b.length, 12);
  for (let count = limit; count >= 1; count -= 1) {
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      if (!pointNear(a[a.length - count + index], b[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return count;
  }
  return 0;
}

function mergeDirected(a: LngLatTuple[], b: LngLatTuple[]): LngLatTuple[] | null {
  const overlap = overlapCount(a, b);
  if (overlap > 0) return [...a, ...b.slice(overlap)];
  return null;
}

function tryMergePreservingDirection(a: LngLatTuple[], b: LngLatTuple[]): LngLatTuple[] | null {
  // MVT clipping preserves source line direction. Do not reverse fragments here: first/last OSM node IDs,
  // oneway, directional lane tags and lane offsets all depend on retaining first-node -> last-node orientation.
  return mergeDirected(a, b) ?? mergeDirected(b, a);
}

export function stitchRoadFragments(fragments: LngLatTuple[][]): LngLatTuple[][] {
  const unique = new Map<string, LngLatTuple[]>();
  for (const fragment of fragments) {
    if (fragment.length >= 2) unique.set(fingerprint(fragment), fragment);
  }
  const parts = [...unique.values()].sort((a, b) => b.length - a.length);

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let a = 0; a < parts.length; a += 1) {
      for (let b = a + 1; b < parts.length; b += 1) {
        const merged = tryMergePreservingDirection(parts[a], parts[b]);
        if (!merged) continue;
        parts[a] = removeConsecutiveDuplicates(merged);
        parts.splice(b, 1);
        changed = true;
        break outer;
      }
    }
  }
  return parts;
}

function segmentCenter(parts: LngLatTuple[][]): LngLatTuple {
  const points = parts.flat();
  if (points.length === 0) return [0, 0];
  const sum = points.reduce(
    (total, [lng, lat]) => ({ lng: total.lng + lng, lat: total.lat + lat }),
    { lng: 0, lat: 0 },
  );
  return [sum.lng / points.length, sum.lat / points.length];
}

function segmentDistance(parts: LngLatTuple[][], center: LngLatTuple): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const point of parts.flat()) nearest = Math.min(nearest, distanceMeters(center, point));
  return nearest;
}

function endpointPosition(segment: RoadWorldSegment, first: boolean): LngLatTuple | undefined {
  const primary = [...segment.parts].sort((a, b) => b.length - a.length)[0];
  if (!primary) return undefined;
  return first ? primary[0] : primary[primary.length - 1];
}

function getNode(nodes: Map<number, RoadGraphNode>, nodeId: number): RoadGraphNode {
  let node = nodes.get(nodeId);
  if (!node) {
    node = { nodeId, incidentSegmentIds: [], outgoing: [], incoming: [] };
    nodes.set(nodeId, node);
  }
  return node;
}

function addArc(nodes: Map<number, RoadGraphNode>, arcs: RoadGraphArc[], arc: RoadGraphArc): void {
  arcs.push(arc);
  getNode(nodes, arc.fromNode).outgoing.push(arc);
  getNode(nodes, arc.toNode).incoming.push(arc);
}

export function buildRoadGraph(segments: RoadWorldSegment[]): Pick<RoadWorld, "nodes" | "arcs"> {
  const nodes = new Map<number, RoadGraphNode>();
  const arcs: RoadGraphArc[] = [];

  for (const segment of segments) {
    const { firstNode, lastNode, oneway, segmentId } = segment.record;
    const first = getNode(nodes, firstNode);
    const last = getNode(nodes, lastNode);
    if (!first.incidentSegmentIds.includes(segmentId)) first.incidentSegmentIds.push(segmentId);
    if (!last.incidentSegmentIds.includes(segmentId)) last.incidentSegmentIds.push(segmentId);
    first.position ??= endpointPosition(segment, true);
    last.position ??= endpointPosition(segment, false);

    if (oneway >= 0) addArc(nodes, arcs, { segmentId, fromNode: firstNode, toNode: lastNode });
    if (oneway <= 0) addArc(nodes, arcs, { segmentId, fromNode: lastNode, toNode: firstNode });
  }

  return { nodes, arcs };
}

export function buildRoadWorld(
  features: GameRoadFeature[],
  cameraCenter: LngLatTuple,
  radiusMeters: number,
  maxSegments: number,
): RoadWorld {
  const accumulators = new Map<number, SegmentAccumulator>();

  for (const feature of features) {
    const record = gameRoadFromFeature(feature);
    if (!record) continue;
    // access/vehicle restrictions are routing policy, not physical-existence filters. Restricted/private roads
    // remain in the world geometry and retain their tags for a later vehicle-policy layer.
    const parts = lineParts(feature);
    if (parts.length === 0) continue;
    const existing = accumulators.get(record.segmentId);
    if (existing) existing.fragments.push(...parts);
    else accumulators.set(record.segmentId, { record, fragments: [...parts] });
  }

  const segments: RoadWorldSegment[] = [];
  for (const { record, fragments } of accumulators.values()) {
    const parts = stitchRoadFragments(fragments);
    if (parts.length === 0) continue;
    const center = segmentCenter(parts);
    const distance = segmentDistance(parts, cameraCenter);
    if (distance > radiusMeters) continue;
    segments.push({
      key: `road-segment:${record.segmentId}`,
      record,
      parts,
      center,
      distanceMeters: distance,
    });
  }

  segments.sort((a, b) => a.distanceMeters - b.distanceMeters || b.record.priority - a.record.priority);
  const bounded = segments.slice(0, maxSegments);
  const graph = buildRoadGraph(bounded);
  return { segments: bounded, ...graph };
}
