import RAPIER from "@dimforge/rapier3d-compat";
import {
  rebaseLocalPhysicsPoint,
  type FloatingOriginFrame,
  type LocalPhysicsPoint,
} from "./floating-origin";
import type { PhysicsSyncBatch, StaticTriMeshCollider } from "./physics-adapter";
import {
  DEFAULT_CHASSIS_CONFIG,
  ZERO_CHASSIS_CONTROLS,
  computeChassisActuation,
  normalizeChassisControls,
  type ChassisControls,
} from "./vehicle-chassis";

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const FIXED_TIMESTEP_SECONDS = 1 / 60;
const MAX_SUBSTEPS = 4;
const PROBE_HALF_EXTENT_METERS = 0.45;
const PROBE_MASS_KG = 50;

type RapierWorld = InstanceType<(typeof RAPIER)["World"]>;
type RapierCollider = ReturnType<RapierWorld["createCollider"]>;
type RapierRigidBody = ReturnType<RapierWorld["createRigidBody"]>;

interface ActiveCollider {
  collider: RapierCollider;
  triangleCount: number;
}

interface DynamicProbe {
  body: RapierRigidBody;
  collider: RapierCollider;
  spawnedAtSubstep: number;
  rebaseCount: number;
}

interface DynamicChassis {
  body: RapierRigidBody;
  collider: RapierCollider;
  spawnedAtSubstep: number;
  rebaseCount: number;
  controls: ChassisControls;
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

export interface DynamicProbeState {
  active: boolean;
  position?: LocalPhysicsPoint;
  linearVelocity?: LocalPhysicsPoint;
  speedMetersPerSecond: number;
  sleeping: boolean;
  contactPairs: number;
  ageSeconds: number;
  rebaseCount: number;
}

export interface DynamicChassisState {
  active: boolean;
  position?: LocalPhysicsPoint;
  linearVelocity?: LocalPhysicsPoint;
  angularVelocity?: LocalPhysicsPoint;
  speedMetersPerSecond: number;
  sleeping: boolean;
  contactPairs: number;
  ageSeconds: number;
  rebaseCount: number;
  controls: ChassisControls;
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

function createColliderDesc(
  collider: StaticTriMeshCollider,
): InstanceType<(typeof RAPIER)["ColliderDesc"]> {
  const vertices = new Float32Array(collider.positions);
  const indices = new Uint32Array(collider.indices);
  return RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
    .setFriction(frictionFor(collider))
    .setRestitution(0);
}

export class RapierPhysicsWorld {
  private world?: RapierWorld;
  private readonly active = new Map<string, ActiveCollider>();
  private probe?: DynamicProbe;
  private chassis?: DynamicChassis;
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
      if (this.addCollider(collider)) updated += 1;
    }

    for (const collider of batch.created) {
      if (this.active.has(collider.colliderId)) {
        if (this.removeCollider(collider.colliderId)) removed += 1;
      }
      if (this.addCollider(collider)) created += 1;
    }

    return this.stats({ created, updated, removed });
  }

  spawnProbe(position: LocalPhysicsPoint): DynamicProbeState {
    if (!this.world) return this.getProbeState();
    this.removeProbe();

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCcdEnabled(true)
        .setCanSleep(true)
        .setLinearDamping(0.08)
        .setAngularDamping(0.12),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        PROBE_HALF_EXTENT_METERS,
        PROBE_HALF_EXTENT_METERS,
        PROBE_HALF_EXTENT_METERS,
      )
        .setMass(PROBE_MASS_KG)
        .setFriction(0.82)
        .setRestitution(0.04),
      body,
    );

    this.probe = {
      body,
      collider,
      spawnedAtSubstep: this.totalSubsteps,
      rebaseCount: 0,
    };
    return this.getProbeState();
  }

  removeProbe(): void {
    if (!this.probe) return;
    this.world?.removeRigidBody(this.probe.body);
    this.probe = undefined;
  }

  spawnChassis(position: LocalPhysicsPoint): DynamicChassisState {
    if (!this.world) return this.getChassisState();
    this.removeChassis();

    const config = DEFAULT_CHASSIS_CONFIG;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCcdEnabled(true)
        .setCanSleep(true)
        .setLinearDamping(config.linearDamping)
        .setAngularDamping(config.angularDamping),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        config.widthMeters / 2,
        config.heightMeters / 2,
        config.lengthMeters / 2,
      )
        .setMass(config.massKg)
        .setFriction(config.friction)
        .setRestitution(config.restitution),
      body,
    );

    this.chassis = {
      body,
      collider,
      spawnedAtSubstep: this.totalSubsteps,
      rebaseCount: 0,
      controls: { ...ZERO_CHASSIS_CONTROLS },
    };
    return this.getChassisState();
  }

  setChassisControls(controls: ChassisControls): DynamicChassisState {
    if (this.chassis) this.chassis.controls = normalizeChassisControls(controls);
    return this.getChassisState();
  }

  removeChassis(): void {
    if (!this.chassis) return;
    this.world?.removeRigidBody(this.chassis.body);
    this.chassis = undefined;
  }

  rebaseDynamicBodies(from: FloatingOriginFrame, to: FloatingOriginFrame): void {
    if (!this.world || from.revision === to.revision) return;

    if (this.probe) {
      const position = this.probe.body.translation();
      this.probe.body.setTranslation(rebaseLocalPhysicsPoint(position, from, to), true);
      this.probe.rebaseCount += 1;
    }

    if (this.chassis) {
      const position = this.chassis.body.translation();
      this.chassis.body.setTranslation(rebaseLocalPhysicsPoint(position, from, to), true);
      this.chassis.rebaseCount += 1;
    }
  }

  advance(elapsedSeconds: number): RapierPhysicsStats {
    if (!this.world) return this.stats();
    const elapsed = Math.min(Math.max(elapsedSeconds, 0), 0.1);
    this.accumulatorSeconds += elapsed;
    let substeps = 0;

    while (this.accumulatorSeconds >= FIXED_TIMESTEP_SECONDS && substeps < MAX_SUBSTEPS) {
      this.applyChassisControls();
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

  getProbeState(): DynamicProbeState {
    if (!this.world || !this.probe) {
      return {
        active: false,
        speedMetersPerSecond: 0,
        sleeping: false,
        contactPairs: 0,
        ageSeconds: 0,
        rebaseCount: 0,
      };
    }

    const position = this.probe.body.translation();
    const velocity = this.probe.body.linvel();
    return {
      active: true,
      position: { x: position.x, y: position.y, z: position.z },
      linearVelocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      speedMetersPerSecond: Math.hypot(velocity.x, velocity.y, velocity.z),
      sleeping: this.probe.body.isSleeping(),
      contactPairs: this.contactPairCount(this.probe.collider),
      ageSeconds: (this.totalSubsteps - this.probe.spawnedAtSubstep) * FIXED_TIMESTEP_SECONDS,
      rebaseCount: this.probe.rebaseCount,
    };
  }

  getChassisState(): DynamicChassisState {
    if (!this.world || !this.chassis) {
      return {
        active: false,
        speedMetersPerSecond: 0,
        sleeping: false,
        contactPairs: 0,
        ageSeconds: 0,
        rebaseCount: 0,
        controls: { ...ZERO_CHASSIS_CONTROLS },
      };
    }

    const position = this.chassis.body.translation();
    const velocity = this.chassis.body.linvel();
    const angularVelocity = this.chassis.body.angvel();
    return {
      active: true,
      position: { x: position.x, y: position.y, z: position.z },
      linearVelocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      angularVelocity: {
        x: angularVelocity.x,
        y: angularVelocity.y,
        z: angularVelocity.z,
      },
      speedMetersPerSecond: Math.hypot(velocity.x, velocity.y, velocity.z),
      sleeping: this.chassis.body.isSleeping(),
      contactPairs: this.contactPairCount(this.chassis.collider),
      ageSeconds: (this.totalSubsteps - this.chassis.spawnedAtSubstep) * FIXED_TIMESTEP_SECONDS,
      rebaseCount: this.chassis.rebaseCount,
      controls: { ...this.chassis.controls },
    };
  }

  debugRender(): { vertices: Float32Array; colors: Float32Array } | null {
    if (!this.world) return null;
    return this.world.debugRender();
  }

  clear(): RapierPhysicsStats {
    this.removeProbe();
    this.removeChassis();
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

  private applyChassisControls(): void {
    if (!this.chassis) return;
    const body = this.chassis.body;
    const actuation = computeChassisActuation(
      body.rotation(),
      body.linvel(),
      this.chassis.controls,
    );

    // Rapier forces persist until reset. For this validation body we own the full actuation budget each
    // substep; the later suspension/tire model will replace this direct force/torque path.
    body.resetForces(true);
    body.resetTorques(true);
    body.addForce(actuation.force, true);
    body.addTorque(actuation.torque, true);
  }

  private contactPairCount(collider: RapierCollider): number {
    if (!this.world) return 0;
    let contactPairs = 0;
    this.world.contactPairsWith(collider, (otherCollider) => {
      if (collider.contactCollider(otherCollider, 0.02)) contactPairs += 1;
    });
    return contactPairs;
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

  private stats(
    delta?: Partial<Pick<RapierPhysicsStats, "created" | "updated" | "removed">>,
  ): RapierPhysicsStats {
    return {
      initialized: this.world !== undefined,
      activeColliders: this.active.size,
      triangleCount: [...this.active.values()].reduce(
        (total, item) => total + item.triangleCount,
        0,
      ),
      created: delta?.created ?? 0,
      updated: delta?.updated ?? 0,
      removed: delta?.removed ?? 0,
      lastSubsteps: this.lastSubsteps,
      totalSubsteps: this.totalSubsteps,
    };
  }
}
