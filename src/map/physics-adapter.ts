import type { RoadCollisionBody, RoadCollisionWorld } from "./road-collision";
import type { FloatingOriginFrame } from "./floating-origin";

export type PhysicsColliderKind = RoadCollisionBody["kind"];

export interface StaticTriMeshCollider {
  colliderId: string;
  kind: PhysicsColliderKind;
  positions: number[];
  indices: number[];
  segmentId?: number;
  nodeId?: number;
  surfaceClass?: RoadCollisionBody["surfaceClass"];
  bridge?: boolean;
  tunnel?: boolean;
  layer?: number;
}

export interface PhysicsSyncBatch {
  originRevision: number;
  created: StaticTriMeshCollider[];
  updated: StaticTriMeshCollider[];
  removed: string[];
  activeColliders: number;
  triangleCount: number;
}

interface ActiveCollider {
  frameRevision: number;
  bodySignature: number;
  collider: StaticTriMeshCollider;
}

function mixHash(hash: number, value: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value * 1000) : 0;
  hash ^= normalized;
  return Math.imul(hash, 16777619) >>> 0;
}

function bodySignature(body: RoadCollisionBody): number {
  let hash = 2166136261;
  hash = mixHash(hash, body.positions.length);
  hash = mixHash(hash, body.indices.length);
  hash = mixHash(hash, body.meterScale);
  hash = mixHash(hash, body.origin.x);
  hash = mixHash(hash, body.origin.y);

  for (const value of body.positions) hash = mixHash(hash, value);
  for (const index of body.indices) hash = mixHash(hash, index);
  return hash;
}

function transformPositions(body: RoadCollisionBody, frame: FloatingOriginFrame): number[] {
  const positions: number[] = [];
  const scaleRatio = body.meterScale / frame.meterScale;
  const originEast = (body.origin.x - frame.mercator.x) / frame.meterScale;
  const originNorth = -(body.origin.y - frame.mercator.y) / frame.meterScale;

  for (let index = 0; index < body.positions.length; index += 3) {
    const bodyEast = body.positions[index];
    const bodySouth = body.positions[index + 1];
    const elevation = body.positions[index + 2];

    positions.push(
      originEast + bodyEast * scaleRatio,
      elevation - frame.elevationMeters,
      originNorth - bodySouth * scaleRatio,
    );
  }
  return positions;
}

function colliderFromBody(body: RoadCollisionBody, frame: FloatingOriginFrame): StaticTriMeshCollider {
  return {
    colliderId: body.bodyId,
    kind: body.kind,
    positions: transformPositions(body, frame),
    indices: [...body.indices],
    segmentId: body.segmentId,
    nodeId: body.nodeId,
    surfaceClass: body.surfaceClass,
    bridge: body.bridge,
    tunnel: body.tunnel,
    layer: body.layer,
  };
}

export class RoadPhysicsAdapter {
  private readonly active = new Map<string, ActiveCollider>();

  sync(world: RoadCollisionWorld, frame: FloatingOriginFrame): PhysicsSyncBatch {
    const desired = new Set(world.bodies.map((body) => body.bodyId));
    const created: StaticTriMeshCollider[] = [];
    const updated: StaticTriMeshCollider[] = [];
    const removed: string[] = [];

    for (const [colliderId] of this.active) {
      if (desired.has(colliderId)) continue;
      this.active.delete(colliderId);
      removed.push(colliderId);
    }

    for (const body of world.bodies) {
      const signature = bodySignature(body);
      const current = this.active.get(body.bodyId);
      const needsUpdate =
        !current ||
        current.frameRevision !== frame.revision ||
        current.bodySignature !== signature;
      if (!needsUpdate) continue;

      const collider = colliderFromBody(body, frame);
      this.active.set(body.bodyId, {
        frameRevision: frame.revision,
        bodySignature: signature,
        collider,
      });
      if (current) updated.push(collider);
      else created.push(collider);
    }

    return {
      originRevision: frame.revision,
      created,
      updated,
      removed,
      activeColliders: this.active.size,
      triangleCount: [...this.active.values()].reduce(
        (total, entry) => total + Math.floor(entry.collider.indices.length / 3),
        0,
      ),
    };
  }

  clear(): string[] {
    const removed = [...this.active.keys()];
    this.active.clear();
    return removed;
  }

  snapshot(): StaticTriMeshCollider[] {
    return [...this.active.values()].map((entry) => entry.collider);
  }
}
