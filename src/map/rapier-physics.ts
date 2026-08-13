import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsSyncBatch, StaticTriMeshCollider } from "./physics-adapter";

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const FIXED_TIMESTEP_SECONDS = 1 / 60;
const MAX_SUBSTEPS = 4;

type RapierWorld = InstanceType<(typeof RAPIER)["World"]>;
type RapierCollider = ReturnType<RapierWorld["createCollider"]>;

interface ActiveCollider {
  collider: RapierCollider;
  triangleCount: number;
}

export interface RapierPhysicsStats {
  initialized: boolean;
  activeColliders: number;
  triangleCount: number;
  created: number;
  updated: number;
  removed: number;
  lastSubsteps: number;
  totalSubsteps: number;
}

function frictionFor(collider: StaticTriMeshCollider): number {
  switch (collider.surfaceClass) {
    case "unpaved":
      return 0.72;
    case "paved":
      return 0.92;
    default:
      return 0.82;
  }
}

function createColliderDesc(collider: StaticTriMeshCollider): InstanceType<(typeof RAPIER)["ColliderDesc"]> {
  const vertices = new Float32Array(collider.positions);
  const indices = new Uint32Array(collider.indices);
  return RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
    .setFriction(frictionFor(collider))
    .setRestitution(0);
}

export class RapierPhysicsWorld {
  private world?: RapierWorld;
  private readonly active = new Map<string, ActiveCollider>();
  private accumulatorSeconds = 0;
  private totalSubsteps = 0;
  private lastSubsteps = 0;

  async init(): Promise<void> {
    if (this.world) return;
    await RAPIER.init();
    this.world = new RAPIER.World(GRAVITY);
  }

  sync(batch: PhysicsSyncBatch): RapierPhysicsStats {
    if (!this.world) return this.stats();

    let created = 0;
    let updated = 0;
    let removed = 0;

    for (const colliderId of batch.removed) {
      if (this.removeCollider(colliderId)) removed += 1;
    }

    for (const collider of batch.updated) {
      if (this.removeCollider(collider.colliderId)) removed += 1;
      if (this.addCollider(collider)) {
        updated += 1;
      }
    }

    for (const collider of batch.created) {
      if (this.active.has(collider.colliderId)) {
        if (this.removeCollider(collider.colliderId)) removed += 1;
      }
      if (this.addCollider(collider)) created += 1;
    }

    return this.stats({ created, updated, removed });
  }

  advance(elapsedSeconds: number): RapierPhysicsStats {
    if (!this.world) return this.stats();
    const elapsed = Math.min(Math.max(elapsedSeconds, 0), 0.1);
    this.accumulatorSeconds += elapsed;
    let substeps = 0;

    while (this.accumulatorSeconds >= FIXED_TIMESTEP_SECONDS && substeps < MAX_SUBSTEPS) {
      this.world.step();
      this.accumulatorSeconds -= FIXED_TIMESTEP_SECONDS;
      substeps += 1;
      this.totalSubsteps += 1;
    }

    if (substeps === MAX_SUBSTEPS && this.accumulatorSeconds >= FIXED_TIMESTEP_SECONDS) {
      this.accumulatorSeconds %= FIXED_TIMESTEP_SECONDS;
    }
    this.lastSubsteps = substeps;
    return this.stats();
  }

  debugRender(): { vertices: Float32Array; colors: Float32Array } | null {
    if (!this.world) return null;
    return this.world.debugRender();
  }

  clear(): RapierPhysicsStats {
    if (this.world) {
      for (const colliderId of [...this.active.keys()]) this.removeCollider(colliderId);
    } else {
      this.active.clear();
    }
    this.accumulatorSeconds = 0;
    this.lastSubsteps = 0;
    return this.stats();
  }

  dispose(): void {
    this.clear();
    this.world?.free();
    this.world = undefined;
  }

  get ready(): boolean {
    return this.world !== undefined;
  }

  private addCollider(collider: StaticTriMeshCollider): boolean {
    if (!this.world || collider.positions.length < 9 || collider.indices.length < 3) return false;
    const desc = createColliderDesc(collider);
    const rapierCollider = this.world.createCollider(desc);
    this.active.set(collider.colliderId, {
      collider: rapierCollider,
      triangleCount: Math.floor(collider.indices.length / 3),
    });
    return true;
  }

  private removeCollider(colliderId: string): boolean {
    const active = this.active.get(colliderId);
    if (!active) return false;
    this.world?.removeCollider(active.collider, true);
    this.active.delete(colliderId);
    return true;
  }

  private stats(delta?: Partial<Pick<RapierPhysicsStats, "created" | "updated" | "removed">>): RapierPhysicsStats {
    return {
      initialized: this.world !== undefined,
      activeColliders: this.active.size,
      triangleCount: [...this.active.values()].reduce((total, item) => total + item.triangleCount, 0),
      created: delta?.created ?? 0,
      updated: delta?.updated ?? 0,
      removed: delta?.removed ?? 0,
      lastSubsteps: this.lastSubsteps,
      totalSubsteps: this.totalSubsteps,
    };
  }
}
