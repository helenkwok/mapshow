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
```

## Modules

### `src/map/floating-origin.ts`

Owns the geographic/local coordinate boundary:

- current geographic anchor;
- origin elevation;
- Mercator coordinate and metres-to-Mercator scale;
- origin revision;
- distance-triggered rebasing.

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
- a fixed-step method is present for later dynamic bodies.

No chassis or vehicle dynamics are created yet.

### `src/map/rapier-debug-layer.ts`

Provides an optional MapLibre/Three.js custom layer that renders Rapier's debug collision lines back in the geographic scene. It converts local physics axes back to the Mapshow rendering convention and applies the current floating-origin transform.

### `src/map/road-collision.ts`

Remains the physics-engine-independent source of simplified road and intersection collision triangles.

## Collider lifecycle

For each streamed road-world refresh:

1. `RoadSurfaceLayer` updates visible road/intersection geometry and `RoadCollisionWorld`;
2. `FloatingOriginController` updates or retains the local frame;
3. `RoadPhysicsAdapter.sync()` returns created/updated/removed local collider descriptors;
4. `RapierPhysicsWorld.sync()` applies that delta to Rapier;
5. the optional debug layer reads Rapier debug geometry for visual verification.

Turning road surfaces off clears both the engine-neutral collider cache and the Rapier world colliders.

Terrain on/off forces a floating-origin reset so the local vertical datum cannot remain anchored to a stale DEM elevation.

## Current scope

Rapier currently represents the **static driveable environment only**.

Implemented:

- streamed road trimesh colliders;
- streamed intersection trimesh colliders;
- floating-origin rebasing;
- surface-class friction defaults;
- debug collision overlay;
- fixed-step world API ready for dynamic bodies.

Not implemented yet:

- player chassis;
- wheel/suspension model;
- tyre friction/slip forces;
- throttle/braking/steering;
- collision filtering for dynamic traffic;
- sleeping/timestep tuning under real vehicle load.

The next physics milestone is a minimal dynamic test body/chassis that validates contact stability on streamed road, intersection and origin-rebase boundaries before implementing a full vehicle model.
