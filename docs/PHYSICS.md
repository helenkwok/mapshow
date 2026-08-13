# Physics architecture

Mapshow keeps geographic rendering, collision generation, coordinate conversion and the physics engine separated.

## Coordinate boundary

MapLibre renders in Web Mercator. Rapier operates in a floating local metre frame:

- `+X`: east
- `+Y`: up
- `+Z`: north
- units: metres

Until a real player vehicle owns the world origin, the camera centre acts as the player proxy. The default origin rebases after roughly 400 m.

Changing the floating origin does not rebuild OSM topology, lane policy, road profiles or visual Three.js road meshes. Static collision bodies are re-expressed through the adapter, while active dynamic-body positions are transformed into the new local frame so the same physical world location is preserved.

Terrain on/off forces an origin reset because the local vertical datum depends on DEM elevation.

## Data flow

```text
RoadCollisionWorld
  renderer-independent triangle bodies
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
  + dynamic probe
  + raycast vehicle chassis
             │
             ▼
DynamicRayCastVehicleController
  four wheel rays + suspension/contact forces
```

## Modules

### `src/map/floating-origin.ts`

Owns the current geographic anchor, elevation datum, Mercator scale, origin revision and local-point rebasing. It has no Rapier dependency.

### `src/map/road-collision.ts`

Produces simplified renderer-independent road/intersection collision triangles from the same vertical profiles used by road rendering.

### `src/map/physics-adapter.ts`

Converts `RoadCollisionWorld` into local static trimesh descriptors with stable collider IDs and create/update/remove deltas. This is the physics-engine-neutral boundary.

### `src/map/rapier-physics.ts`

Owns the Rapier world:

- gravity along local `-Y`;
- one static trimesh for each streamed road/intersection collision body;
- fixed 1/60 s stepping with bounded catch-up;
- dynamic drop probe;
- dynamic chassis and Rapier raycast vehicle controller;
- floating-origin dynamic-body rebasing;
- per-wheel contact/suspension diagnostics.

### `src/map/vehicle-chassis.ts`

Defines engine-independent chassis dimensions, mass/material defaults and normalized user controls. It no longer applies direct thrust or yaw torque to the rigid body.

### `src/map/vehicle-suspension.ts`

Defines the first wheel/contact model:

- four wheel connection points derived from chassis dimensions;
- suspension direction and axle orientation;
- front steering / rear drive / all-wheel brake roles;
- wheel radius and suspension rest/travel values;
- stiffness, compression damping, relaxation damping and maximum suspension force;
- friction/slip and side-friction tuning;
- speed-sensitive steering authority;
- control-to-wheel engine/brake/steering mapping.

### `src/map/rapier-debug-layer.ts`

Renders Rapier debug lines back through MapLibre/Three.js using the current floating-origin transform.

## Static collider lifecycle

For each road-world refresh:

1. `RoadSurfaceLayer` updates rendered road/intersection geometry and `RoadCollisionWorld`;
2. `FloatingOriginController` retains or rebases the local frame;
3. dynamic bodies are transformed if the frame changed;
4. `RoadPhysicsAdapter.sync()` returns static collider deltas;
5. `RapierPhysicsWorld.sync()` applies those deltas;
6. the Rapier wheel rays query those static colliders during each physics substep.

Turning simulation roads off clears both the adapter cache and Rapier static/dynamic state.

## Fixed-step simulation

The browser animation loop advances Rapier independently of map streaming:

- physics step: 1/60 s;
- elapsed browser time is accumulated;
- catch-up substeps are bounded;
- excess accumulated time is discarded after the cap rather than causing an unbounded stall spiral;
- status/debug updates are throttled separately from physics stepping.

## Dynamic drop probe

**Drop physics probe** spawns a small cuboid above the nearest active road collider. It remains useful for isolating raw collider/contact problems without vehicle-controller complexity.

It tests gravity, road/intersection seams, bridge/tunnel continuity, streamed collider boundaries, terrain-mode changes and floating-origin rebasing.

## Raycast vehicle chassis

**Spawn chassis** creates a 1,200 kg validation chassis plus four Rapier raycast wheels.

Controls:

```text
W / S     forward / reverse wheel engine force
A / D     front-wheel steering
Space     all-wheel brake
```

Current wheel layout:

- front-left and front-right: steering;
- rear-left and rear-right: engine force;
- all four wheels: braking;
- suspension rays: local `-Y`;
- wheel axle: local `-X`, chosen so positive engine force follows Mapshow local `+Z` forward.

Each physics substep maps normalized controls to wheel steering/engine/brake values, then calls Rapier's `DynamicRayCastVehicleController.updateVehicle()` before the world step. Wheel raycasts exclude dynamic bodies so they target the streamed static road/intersection collision world rather than the chassis or diagnostic probe.

The runtime exposes, per wheel:

- ground-contact state;
- contact point;
- suspension length and suspension force;
- steering angle;
- engine/brake values;
- forward and side impulses.

This validates that the generated world supports the chassis through suspension contacts rather than through direct body forces.

## Testing

Vitest covers both pure contracts and the Rapier/WASM boundary:

- `floating-origin.test.ts` — rebase round trips and threshold behavior;
- `physics-adapter.test.ts` — collider creation, retention, replacement and removal;
- `road-collision.test.ts` — collision simplification/index generation;
- `vehicle-chassis.test.ts` — chassis/control contract;
- `vehicle-suspension.test.ts` — wheel layout and control-to-wheel mapping;
- `rapier-physics.test.ts` — a real Rapier world with a static road trimesh where the four-wheel suspension settles onto the road and wheel engine force moves the chassis forward.

CI runs `npm test` before strict TypeScript/Vite production build checks.

## Current scope

Implemented:

- streamed road/intersection trimesh colliders;
- floating-origin rebasing;
- fixed-step Rapier runtime;
- physics debug overlay;
- dynamic drop probe;
- four-wheel raycast suspension;
- front steering, rear drive and all-wheel braking;
- per-wheel contact/suspension diagnostics;
- deterministic Rapier/WASM integration tests.

Not implemented yet:

- physical wheel rigid bodies or wheel visual animation;
- custom tyre load/slip curves;
- differential/gearing/powertrain simulation;
- production steering/throttle/brake behavior;
- route/lane-following integration;
- dynamic traffic collision filtering;
- large-scale dynamic-body solver/sleeping tuning.

The next vehicle-physics work should use the available wheel load/contact/impulse data to decide whether Rapier's built-in raycast tyre behavior is sufficient or whether Mapshow needs a custom longitudinal/lateral tyre-force model.
