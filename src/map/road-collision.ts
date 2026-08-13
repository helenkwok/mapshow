import type { MercatorCoordinate } from "maplibre-gl";

export interface CollisionPoint {
  x: number;
  y: number;
  z: number;
}

export interface RoadCollisionBody {
  bodyId: string;
  kind: "road-segment" | "intersection";
  origin: MercatorCoordinate;
  meterScale: number;
  positions: number[];
  indices: number[];
  segmentId?: number;
  nodeId?: number;
  surfaceClass?: "paved" | "unpaved" | "unknown";
  bridge?: boolean;
  tunnel?: boolean;
  layer?: number;
}

export interface RoadCollisionWorld {
  bodies: RoadCollisionBody[];
  triangleCount: number;
}

const COLLISION_SAMPLE_SPACING_METERS = 12;

export function simplifyCollisionPoints(
  points: CollisionPoint[],
  spacingMeters = COLLISION_SAMPLE_SPACING_METERS,
): CollisionPoint[] {
  if (points.length <= 2) return [...points];
  const simplified: CollisionPoint[] = [points[0]];
  let last = points[0];

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const distance = Math.hypot(point.x - last.x, point.y - last.y, point.z - last.z);
    if (distance < spacingMeters) continue;
    simplified.push(point);
    last = point;
  }

  const finalPoint = points[points.length - 1];
  if (simplified[simplified.length - 1] !== finalPoint) simplified.push(finalPoint);
  return simplified;
}

export function buildCollisionStrip(
  points: CollisionPoint[],
  halfWidthMeters: number,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  if (points.length < 2) return { positions, indices };

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let dx = next.x - previous.x;
    let dy = next.y - previous.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= length;
      dy /= length;
    }
    const normalX = -dy;
    const normalY = dx;
    const point = points[index];
    positions.push(
      point.x + normalX * halfWidthMeters,
      point.y + normalY * halfWidthMeters,
      point.z,
      point.x - normalX * halfWidthMeters,
      point.y - normalY * halfWidthMeters,
      point.z,
    );
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left0 = index * 2;
    const right0 = left0 + 1;
    const left1 = left0 + 2;
    const right1 = left0 + 3;
    indices.push(left0, right0, left1, right0, right1, left1);
  }

  return { positions, indices };
}

export function collisionWorldFromBodies(bodies: RoadCollisionBody[]): RoadCollisionWorld {
  return {
    bodies,
    triangleCount: bodies.reduce((total, body) => total + Math.floor(body.indices.length / 3), 0),
  };
}
