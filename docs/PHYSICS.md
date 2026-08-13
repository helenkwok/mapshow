# Physics architecture

Mapshow keeps geographic rendering, collision generation and the physics engine separated.

## Coordinate boundary

MapLibre renders the world in Web Mercator coordinates. Vehicle physics should not use planet-scale map coordinates, so Mapshow converts collision geometry into a floating local metre frame.

Until a player vehicle exists, the camera centre acts as the player proxy. The default origin shifts after roughly 400 m.

Physics axes are:

- `+X`: east
- `+Y`: up
- `+Z`: north
- units: metres

Changing the floating origin does not rebuild OSM topology, lanes, road profiles or visual Three.js road meshes. Existing collision bodies are re-expressed in the new local frame and passed through the collider sync boundary.

Dynamic bodies are handled separately: their local position is transformed from the old floating frame into the new one so the same physical world location is preserved across a rebase.

## Data flow

```text
RoadCollisionWorld
  geographic/MapLibre-local triangle bodies
             │
             ▼
RoadPhysicsAdapter
  local X-east / Y-up / Z-north metres
             │
             ▼
PhysicsSyncBatch
  created / updated / removed collider IDs
             │
             ▼
RapierPhysicsWorld
  streamed static trimesh colliders
  + dynamic validation probe
```

## Modules

### `src/map/floating-origin.ts`

Owns the geographic/local coordinate boundary:

- current geographic anchor;
- origin elevation;
- Mercator coordinate and metres-to-Mercator scale;
- origin revision;
- distance-triggered rebasing;
- local point transformation between floating-origin revisions.

It has no dependency on Rapier.

### `src/map/physics-adapter.ts`

Converts renderer-independent `RoadCollisionWorld` bodies into local static trimesh descriptors:

- stable collider IDs;
- X-east/Y-up/Z-north vertex coordinates;
- created/updated/removed delta batches;
- road/intersection metadata;
- retransformation after an origin revision changes.

This remains the engine-neutral contract.

### `src/map/rapier-physics.ts`

Consumes `PhysicsSyncBatch` and owns the Rapier world:

- gravity uses local `-Y`;
- one standalone static trimesh collider is created for each streamed road/intersection collision body;
- collider IDs remain owned by Mapshow, while Rapier handles are internal;
- streamed removals delete Rapier colliders;
- updates replace colliders without changing the browser road-world contract;
- friction is selected from the coarse road surface class;
- the world advances at a fixed 1/60 s timestep with bounded catch-up;
- one small dynamic validation cuboid can be spawned above the nearest active road collider;
- the probe uses CCD and reports position, velocity, contact-pair count, sleeping state and rebase count;
- probe position is transformed rather than respawned when the floating origin moves.

The probe is not a vehicle or chassis model.

### `src/map/rapier-debug-layer.ts`

Provides an optional MapLibre/Three.js custom layer that renders Rapier's debug collision lines back in the geographic scene. It converts local physics axes back to the Mapshow rendering convention and applies the current floating-origin transform.

With the dynamic probe active, the debug geometry is refreshed while the probe is moving.

### `src/map/road-collision.ts`

Remains the physics-engine-independent source of simplified road and intersection collision triangles.

## Collider and dynamic-body lifecycle

For each streamed road-world refresh:

1. `RoadSurfaceLayer` updates visible road/intersection geometry and `RoadCollisionWorld`;
2. `FloatingOriginController` updates or retains the local frame;
3. if the frame changed, the dynamic probe is transformed into the new local frame;
4. `RoadPhysicsAdapter.sync()` returns created/updated/removed local collider descriptors;
5. `RapierPhysicsWorld.sync()` applies that static-collider delta to Rapier;
6. the optional debug layer reads Rapier debug geometry for visual verification.

A browser animation loop advances Rapier independently of map streaming. This means a dynamic probe keeps falling and settling even when no map tile or road-world update occurs.

Turning road surfaces off clears both the engine-neutral collider cache and the Rapier world, including the probe.

Terrain on/off forces a floating-origin reset so the local vertical datum cannot remain anchored to a stale DEM elevation. An active probe is transformed through that reset.

## Dynamic probe workflow

When active road colliders exist, **Drop physics probe**:

1. chooses the nearest active road collider in the local physics frame;
2. finds an approximate horizontal centre and surface height;
3. spawns a small cuboid roughly 6 m above it;
4. enables the Rapier debug overlay;
5. lets gravity/contact evolve under the fixed-step loop;
6. reports probe height, speed, contacts, sleep state and origin-rebase count in the status line.

This is intended to expose missing road collision, intersection seams, unstable contacts, streamed-collider gaps and floating-origin mistakes before a vehicle is added.

## Current scope

Implemented:

- streamed road trimesh colliders;
- streamed intersection trimesh colliders;
- floating-origin rebasing;
- surface-class friction defaults;
- debug collision overlay;
- fixed-step Rapier simulation;
- minimal dynamic contact/rebase probe.

Not implemented yet:

- player chassis;
- wheel/suspension model;
- tyre friction/slip forces;
- throttle/braking/steering;
- collision filtering for dynamic traffic;
- production tuning for sleeping, solver iterations or large numbers of dynamic bodies.

The next vehicle milestone should begin only after the probe remains stable across road surfaces, generated intersections, streamed collider boundaries and origin rebases.
